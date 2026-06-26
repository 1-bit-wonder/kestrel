import type { EventType, KestrelEvent } from '$lib/schema/event';

/** Client-safe presentation helpers for events (no server imports). */

export const TYPE_META: Record<EventType, { label: string; color: string; dot: string }> = {
	exec: { label: 'exec', color: 'text-ember', dot: 'bg-ember' },
	exit: { label: 'exit', color: 'text-ktext-mute', dot: 'bg-ktext-faint' },
	file_open: { label: 'file', color: 'text-amber-300', dot: 'bg-amber-400' },
	net_connect: { label: 'net', color: 'text-sky-300', dot: 'bg-sky-400' },
	listen: { label: 'listen', color: 'text-violet-300', dot: 'bg-violet-400' },
	priv_change: { label: 'priv', color: 'text-rose-300', dot: 'bg-rose-400' },
	module_load: { label: 'module', color: 'text-fuchsia-300', dot: 'bg-fuchsia-400' }
};

/** A short human-readable summary of the event's type-specific payload. */
export function eventDetail(e: KestrelEvent): string {
	switch (e.type) {
		case 'exec':
			return e.cmdline ?? e.exe ?? e.comm;
		case 'exit':
			return `${e.comm} exited`;
		case 'file_open':
			return `${e.file_path}${e.flags ? ` (${e.flags})` : ''}`;
		case 'net_connect':
			return `→ ${e.dest_ip}:${e.dest_port}/${e.proto ?? 'tcp'}`;
		case 'listen':
			return `listening :${e.dest_port}/${e.proto ?? 'tcp'}`;
		default:
			return e.cmdline ?? e.exe ?? '';
	}
}

/** Last path component of a (possibly trailing-slashed) path. */
export function baseName(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const i = trimmed.lastIndexOf('/');
	return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Best display name for the process behind an event: the executed binary's
 * basename when we know it, else the kernel `comm`.
 *
 * Why not just `comm`: at `sys_enter_execve` the kernel hasn't switched the
 * task image yet, so `bpf_get_current_comm` returns the *caller* (the shell
 * that spawned the program), not the program. The agent ships the real target
 * in `exe`, so for anything carrying an exe the basename is the accurate name
 * (`nano`, not `bash`). Exit events have no exe and their `comm` is already the
 * post-exec name, so the fallback is correct there.
 */
export function procName(e: KestrelEvent): string {
	return e.exe ? baseName(e.exe) : e.comm;
}

export function fmtTime(ts: string): string {
	const d = new Date(ts);
	return (
		d.toLocaleTimeString('en-GB', { hour12: false }) +
		'.' +
		String(d.getMilliseconds()).padStart(3, '0')
	);
}
