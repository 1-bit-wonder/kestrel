// SPDX-License-Identifier: GPL-2.0
//
// Kestrel execve probe (SPEC §6). One event per process exec, pushed to a ring
// buffer for the Go userspace agent to drain. Phase 1 keeps the payload lean —
// pid, ppid, uid, comm, and the executable path — which is everything the live
// feed (8.1) and the upcoming process tree (8.2, via ppid) need.
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

// Shared layout with the Go side. bpf2go's `-type event` mirrors this into a Go
// `execEvent` struct, so the field order/types here ARE the decode contract.
struct event {
	__u32 pid;
	__u32 ppid;
	__u32 uid;
	__u8 comm[TASK_COMM_LEN];
	__u8 filename[FILENAME_LEN];
};

// Make the verifier/bpf2go emit BTF for `struct event` even though it only ever
// exists inside the ring buffer (never as a global). Required for `-type event`.
const struct event *unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); // 16 MiB — generous; exec is low-rate.
} events SEC(".maps");

SEC("tracepoint/syscalls/sys_enter_execve")
int handle_execve(struct trace_event_raw_sys_enter *ctx)
{
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0; // ring full — drop rather than block the syscall.

	__u64 pid_tgid = bpf_get_current_pid_tgid();
	e->pid = pid_tgid >> 32; // upper 32 bits = tgid (the userspace "pid")
	e->uid = (__u32)bpf_get_current_uid_gid();

	// Parent pid via the current task's real_parent — CO-RE relocated.
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);

	bpf_get_current_comm(&e->comm, sizeof(e->comm));

	// args[0] of sys_enter_execve is `const char *filename` (userspace ptr).
	const char *filename = (const char *)ctx->args[0];
	bpf_probe_read_user_str(&e->filename, sizeof(e->filename), filename);

	bpf_ringbuf_submit(e, 0);
	return 0;
}
