// SPDX-License-Identifier: GPL-2.0
//
// Kestrel runtime-security probes (SPEC §6). Several hooks share one ring buffer
// and one event struct, discriminated by `kind`:
//   - sys_enter_execve        → EVENT_EXEC:        what ran (pid, ppid, uid, comm, path).
//   - sched_process_exit      → EVENT_EXIT:        a process ended.
//   - sys_enter_openat        → EVENT_FILE_OPEN:   a file was opened (path + flags).
//   - security_socket_connect → EVENT_NET_CONNECT: an outbound connection (dest ip/port).
// exec/exit give the live feed (8.1) its spine and the process tree (8.2) its
// lifetimes; file_open feeds the sensitive-file monitor (8.4) and net_connect
// the network map (8.3).
//
// Policy lives in userspace: this probe emits EVERY openat and forwards it over
// the ring buffer; the Go agent filters to a sensitive-path watch list before
// shipping (keeps the verifier surface minimal and the watch list editable).
// In-kernel path pre-filtering is a future optimization if ring pressure bites.
//
// CO-RE: we include the BTF-generated vmlinux.h and read kernel fields with
// BPF_CORE_READ, so the same object loads across kernel versions (the verifier
// relocates field offsets at load time from /sys/kernel/btf/vmlinux). No kernel
// headers required at build time.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define TASK_COMM_LEN 16
#define FILENAME_LEN 256

// Event kind discriminator — mirrored as constants on the Go side.
#define EVENT_EXEC 0
#define EVENT_EXIT 1
#define EVENT_FILE_OPEN 2
#define EVENT_NET_CONNECT 3

// Address families (vmlinux.h has the structs but not these macros).
#define AF_INET 2
#define AF_INET6 10

// Shared layout with the Go side. bpf2go's `-type event` mirrors this into a Go
// `execEvent` struct, so the field order/types here ARE the decode contract.
// Scalars first (packs cleanly), then the byte arrays. Type-specific fields are
// zero on events that don't use them.
struct event {
	__u32 kind;
	__u32 pid;
	__u32 ppid;
	__u32 uid;
	__s32 open_flags;             // file_open: raw open(2) flags.
	__u16 family;                 // net_connect: AF_INET / AF_INET6.
	__u16 dport;                  // net_connect: dest port (network byte order).
	__u8 proto;                   // net_connect: IPPROTO_TCP(6)/UDP(17).
	__u8 daddr4[4];               // net_connect AF_INET: dest IPv4 (network order).
	__u8 daddr6[16];              // net_connect AF_INET6: dest IPv6 (network order).
	__u8 comm[TASK_COMM_LEN];
	__u8 filename[FILENAME_LEN];  // exec: bin path; file_open: opened path; else empty.
};

// Make the verifier/bpf2go emit BTF for `struct event` even though it only ever
// exists inside the ring buffer (never as a global). Required for `-type event`.
const struct event *unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); // 16 MiB — generous; shared by all event kinds.
} events SEC(".maps");

// Reserve a zeroed event of the given kind, with the common identity fields
// filled from the current task. Returns NULL if the ring is full (caller drops).
static __always_inline struct event *new_event(__u32 kind)
{
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return NULL;

	// Zero the type-specific fields so a stale ring slot never leaks bytes into
	// an event kind that doesn't set them (the path buffer is always written).
	e->kind = kind;
	e->open_flags = 0;
	e->family = 0;
	e->dport = 0;
	e->proto = 0;
	__builtin_memset(&e->daddr4, 0, sizeof(e->daddr4));
	__builtin_memset(&e->daddr6, 0, sizeof(e->daddr6));

	__u64 pid_tgid = bpf_get_current_pid_tgid();
	e->pid = pid_tgid >> 32; // upper 32 bits = tgid (the userspace "pid")
	e->uid = (__u32)bpf_get_current_uid_gid();

	// Parent pid via the current task's real_parent — CO-RE relocated.
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);

	bpf_get_current_comm(&e->comm, sizeof(e->comm));
	return e;
}

SEC("tracepoint/syscalls/sys_enter_execve")
int handle_execve(struct trace_event_raw_sys_enter *ctx)
{
	struct event *e = new_event(EVENT_EXEC);
	if (!e)
		return 0; // ring full — drop rather than block the syscall.

	// args[0] of sys_enter_execve is `const char *filename` (userspace ptr).
	const char *filename = (const char *)ctx->args[0];
	bpf_probe_read_user_str(&e->filename, sizeof(e->filename), filename);

	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/sched/sched_process_exit")
int handle_exit(void *ctx)
{
	// sched_process_exit fires for every thread; emit only when the thread-group
	// leader exits (thread id == tgid) so we report process exits, not per-thread
	// teardown. This pairs each EVENT_EXEC (also keyed on the tgid) with one exit.
	__u64 pid_tgid = bpf_get_current_pid_tgid();
	if ((__u32)pid_tgid != (__u32)(pid_tgid >> 32))
		return 0;

	struct event *e = new_event(EVENT_EXIT);
	if (!e)
		return 0;

	e->filename[0] = 0; // no path for an exit.

	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/syscalls/sys_enter_openat")
int handle_openat(struct trace_event_raw_sys_enter *ctx)
{
	struct event *e = new_event(EVENT_FILE_OPEN);
	if (!e)
		return 0;

	// sys_enter_openat args: [0]=dfd, [1]=const char *filename, [2]=int flags.
	const char *filename = (const char *)ctx->args[1];
	bpf_probe_read_user_str(&e->filename, sizeof(e->filename), filename);
	e->open_flags = (__s32)ctx->args[2];

	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("kprobe/security_socket_connect")
int BPF_KPROBE(handle_connect, struct socket *sock, struct sockaddr *address, int addrlen)
{
	// Only IP connections are interesting for the network map; skip AF_UNIX etc.
	__u16 family = BPF_CORE_READ(address, sa_family);
	if (family != AF_INET && family != AF_INET6)
		return 0;

	struct event *e = new_event(EVENT_NET_CONNECT);
	if (!e)
		return 0;

	e->filename[0] = 0; // no path for a connection.
	e->family = family;
	// L4 protocol from the socket (TCP vs UDP "connect"). sk_protocol is a plain
	// field on modern kernels; CO-RE relocates it.
	e->proto = BPF_CORE_READ(sock, sk, sk_protocol);

	if (family == AF_INET) {
		struct sockaddr_in *in = (struct sockaddr_in *)address;
		e->dport = BPF_CORE_READ(in, sin_port); // network byte order.
		BPF_CORE_READ_INTO(&e->daddr4, in, sin_addr.s_addr);
	} else {
		struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)address;
		e->dport = BPF_CORE_READ(in6, sin6_port);
		BPF_CORE_READ_INTO(&e->daddr6, in6, sin6_addr);
	}

	bpf_ringbuf_submit(e, 0);
	return 0;
}
