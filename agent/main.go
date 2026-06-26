// Command kestrel-agent loads the execve eBPF probe, drains its ring buffer,
// enriches each event, and ships batches to the SvelteKit ingest endpoint.
//
// MUST run on a real kernel as root — i.e. INSIDE the dev VM, never the host
// (CLAUDE.md Golden Rule #1). Build it anywhere (compiling is safe); only
// loading/attaching touches the kernel.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"log"
	"os"
	"os/signal"
	"os/user"
	"strconv"
	"syscall"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"

	"kestrel/agent/internal/decode"
	"kestrel/agent/internal/procscan"
	"kestrel/agent/internal/ship"
)

// Two-step codegen, run via `go generate ./...` inside the VM or `nix develop`:
//  1. Dump this kernel's BTF to a self-contained vmlinux.h for CO-RE.
//  2. bpf2go compiles exec.bpf.c with clang and generates the typed loader
//     (execObjects/loadExecObjects) plus the `execEvent` decode struct.
//
// -D__TARGET_ARCH_x86 picks the register layout for bpf_tracing.h's PT_REGS
// macros (used by BPF_KPROBE in the connect probe). The project targets x86_64
// hosts (dev VM + VPS); CO-RE still relocates field offsets across kernels.
//
//go:generate sh -c "bpftool btf dump file /sys/kernel/btf/vmlinux format c > bpf/vmlinux.h"
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc $BPF_CLANG -type event exec bpf/exec.bpf.c -- -I bpf/headers -I bpf -D__TARGET_ARCH_x86

func main() {
	log.SetFlags(log.Ltime)

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	// Default targets the host app from inside the VM (QEMU's gateway is the
	// host). Override with KESTREL_INGEST_URL when co-located in prod.
	ingestURL := getenv("KESTREL_INGEST_URL", "http://10.0.2.2:5173/api/ingest")

	// Pre-5.11 kernels need the memlock rlimit lifted before loading maps.
	if err := rlimit.RemoveMemlock(); err != nil {
		log.Fatalf("remove memlock: %v", err)
	}

	objs := execObjects{}
	if err := loadExecObjects(&objs, nil); err != nil {
		log.Fatalf("load bpf objects: %v (are you root, in the VM?)", err)
	}
	defer objs.Close()

	tpExec, err := link.Tracepoint("syscalls", "sys_enter_execve", objs.HandleExecve, nil)
	if err != nil {
		log.Fatalf("attach execve tracepoint: %v", err)
	}
	defer tpExec.Close()

	tpExit, err := link.Tracepoint("sched", "sched_process_exit", objs.HandleExit, nil)
	if err != nil {
		log.Fatalf("attach sched_process_exit tracepoint: %v", err)
	}
	defer tpExit.Close()

	// File opens → sensitive-file monitor (8.4). The probe emits every openat;
	// we filter to the watch list below before shipping.
	tpOpenat, err := link.Tracepoint("syscalls", "sys_enter_openat", objs.HandleOpenat, nil)
	if err != nil {
		log.Fatalf("attach sys_enter_openat tracepoint: %v", err)
	}
	defer tpOpenat.Close()

	// Outbound connections → network map (8.3). security_socket_connect is the
	// LSM hook covering TCP+UDP, IPv4+IPv6, before the connection leaves.
	kpConnect, err := link.Kprobe("security_socket_connect", objs.HandleConnect, nil)
	if err != nil {
		log.Fatalf("attach security_socket_connect kprobe: %v", err)
	}
	defer kpConnect.Close()

	rd, err := ringbuf.NewReader(objs.Events)
	if err != nil {
		log.Fatalf("open ringbuf reader: %v", err)
	}
	defer rd.Close()

	shipper := ship.New(ingestURL, hostname)
	defer shipper.Close()

	// Unblock rd.Read() on Ctrl-C / SIGTERM by closing the reader.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		rd.Close()
	}()

	log.Printf("kestrel-agent: tracing exec/exit/open/connect on %q → %s", hostname, ingestURL)

	// Seed the dashboard's process tree with everything already running: the
	// execve probe only sees processes that exec AFTER it attaches, so without
	// this the pre-existing ancestry (systemd → … → your shell) is missing and
	// live execs render as disconnected roots (SPEC §8.2). Done after attach so
	// we don't miss execs during the scan; the app upserts by pid, so a process
	// that both appears here and execs live just refreshes its node.
	snap := procscan.Snapshot()
	for i := range snap {
		snap[i].User = lookupUser(snap[i].UID)
		shipper.Add(snap[i])
	}
	log.Printf("kestrel-agent: seeded %d running processes", len(snap))

	// Don't trace ourselves. The agent POSTs every batch to the ingest endpoint,
	// so the connect probe would see its own outbound connection (~2/sec) plus
	// its own file opens — pure feedback noise that would dominate the network
	// map. Like Falco/Tetragon, we drop events from our own pid. (The startup
	// /proc snapshot still emits the agent once, so it shows as an idle node.)
	selfPID := uint32(os.Getpid())

	var event execEvent
	for {
		record, err := rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				log.Println("kestrel-agent: ring buffer closed, shutting down")
				return
			}
			log.Printf("ringbuf read: %v", err)
			continue
		}

		// The ring sample is the raw C `struct event` in native (LE) byte order.
		if err := binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &event); err != nil {
			log.Printf("decode event: %v", err)
			continue
		}

		if event.Pid == selfPID {
			continue // our own activity — see selfPID above.
		}

		// `kind` discriminates the probes sharing this ring buffer. The common
		// identity fields are the same for every kind; the type-specific fields
		// are filled per branch below.
		e := ship.Event{
			PID:  event.Pid,
			PPID: event.Ppid,
			UID:  event.Uid,
			User: lookupUser(event.Uid),
			Comm: gostr(event.Comm[:]),
		}

		switch event.Kind {
		case kindExec:
			e.Type, e.Exe = "exec", gostr(event.Filename[:])
		case kindExit:
			e.Type = "exit"
		case kindFileOpen:
			// The probe ships every openat; only sensitive paths reach the feed.
			path := gostr(event.Filename[:])
			if !decode.Watched(path) {
				continue
			}
			e.Type, e.FilePath, e.Flags = "file_open", path, decode.FileOpenFlags(event.OpenFlags)
		case kindNetConnect:
			dest := decode.FormatIP(event.Family, event.Daddr4, event.Daddr6)
			proto := decode.Proto(event.Proto)
			if dest == "" || proto == "" {
				continue // unexpected family/proto — schema requires both.
			}
			e.Type, e.DestIP, e.DestPort, e.Proto = "net_connect", dest, decode.Port(event.Dport), proto
		default:
			continue // unknown kind — forward-compat with a newer probe.
		}

		shipper.Add(e)
	}
}

// Event kinds — mirror the EVENT_* constants in exec.bpf.c.
const (
	kindExec       uint32 = 0
	kindExit       uint32 = 1
	kindFileOpen   uint32 = 2
	kindNetConnect uint32 = 3
)

// gostr turns a fixed-size, NUL-padded C char array into a Go string.
func gostr(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		return string(b[:i])
	}
	return string(b)
}

// lookupUser resolves a uid to a username, cached (the main loop is the only
// caller, so a plain map is safe). Empty string if the uid has no passwd entry.
var userCache = map[uint32]string{}

func lookupUser(uid uint32) string {
	if name, ok := userCache[uid]; ok {
		return name
	}
	name := ""
	if u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10)); err == nil {
		name = u.Username
	}
	userCache[uid] = name
	return name
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
