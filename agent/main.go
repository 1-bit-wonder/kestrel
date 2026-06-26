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

	"kestrel/agent/internal/procscan"
	"kestrel/agent/internal/ship"
)

// Two-step codegen, run via `go generate ./...` inside the VM or `nix develop`:
//  1. Dump this kernel's BTF to a self-contained vmlinux.h for CO-RE.
//  2. bpf2go compiles exec.bpf.c with clang and generates the typed loader
//     (execObjects/loadExecObjects) plus the `execEvent` decode struct.
//
//go:generate sh -c "bpftool btf dump file /sys/kernel/btf/vmlinux format c > bpf/vmlinux.h"
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc $BPF_CLANG -type event exec bpf/exec.bpf.c -- -I bpf/headers -I bpf

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

	log.Printf("kestrel-agent: tracing execve on %q → %s", hostname, ingestURL)

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

		// `kind` discriminates the two probes sharing this ring buffer; an exit
		// carries no executable path (SPEC §8.2 process lifecycle).
		typ, exe := "exec", gostr(event.Filename[:])
		if event.Kind == kindExit {
			typ, exe = "exit", ""
		}

		shipper.Add(ship.Event{
			Type: typ,
			PID:  event.Pid,
			PPID: event.Ppid,
			UID:  event.Uid,
			User: lookupUser(event.Uid),
			Comm: gostr(event.Comm[:]),
			Exe:  exe,
		})
	}
}

// Event kinds — mirror the EVENT_EXEC/EVENT_EXIT constants in exec.bpf.c.
const (
	kindExec uint32 = 0
	kindExit uint32 = 1
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
