// SPDX-License-Identifier: GPL-2.0
//
// Kestrel process-lifecycle probes (SPEC §6). Two tracepoints share one ring
// buffer and one event struct, discriminated by `kind`:
//   - sys_enter_execve   → EVENT_EXEC: what ran (pid, ppid, uid, comm, path).
//   - sched_process_exit → EVENT_EXIT: a process ended (pid, ppid, uid, comm).
// Together they give the live feed (8.1) its spine and the process tree (8.2)
// the lifetimes/liveness it needs (a node is "running" until its exit arrives).
//
// CO-RE: we include the BTF-generated vmlinux.h and read kernel fields with
// BPF_CORE_READ, so the same object loads across kernel versions (the verifier
// relocates field offsets at load time from /sys/kernel/btf/vmlinux). No kernel
// headers required at build time.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define TASK_COMM_LEN 16
#define FILENAME_LEN 256

// Event kind discriminator — mirrored as constants on the Go side.
#define EVENT_EXEC 0
#define EVENT_EXIT 1

// Shared layout with the Go side. bpf2go's `-type event` mirrors this into a Go
// `execEvent` struct, so the field order/types here ARE the decode contract.
struct event {
	__u32 kind;
	__u32 pid;
	__u32 ppid;
	__u32 uid;
	__u8 comm[TASK_COMM_LEN];
	__u8 filename[FILENAME_LEN]; // exec only; empty for exit.
};

// Make the verifier/bpf2go emit BTF for `struct event` even though it only ever
// exists inside the ring buffer (never as a global). Required for `-type event`.
const struct event *unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); // 16 MiB — generous; exec/exit are low-rate.
} events SEC(".maps");

// Fill the identity fields common to every event from the current task.
static __always_inline void fill_common(struct event *e)
{
	__u64 pid_tgid = bpf_get_current_pid_tgid();
	e->pid = pid_tgid >> 32; // upper 32 bits = tgid (the userspace "pid")
	e->uid = (__u32)bpf_get_current_uid_gid();

	// Parent pid via the current task's real_parent — CO-RE relocated.
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);

	bpf_get_current_comm(&e->comm, sizeof(e->comm));
}

SEC("tracepoint/syscalls/sys_enter_execve")
int handle_execve(struct trace_event_raw_sys_enter *ctx)
{
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0; // ring full — drop rather than block the syscall.

	e->kind = EVENT_EXEC;
	fill_common(e);

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

	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0;

	e->kind = EVENT_EXIT;
	fill_common(e);
	e->filename[0] = 0; // no path for an exit.

	bpf_ringbuf_submit(e, 0);
	return 0;
}
