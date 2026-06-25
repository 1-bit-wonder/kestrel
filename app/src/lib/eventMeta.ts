import type { EventType, KestrelEvent } from '$lib/schema/event';

/** Client-safe presentation helpers for events (no server imports). */

export const TYPE_META: Record<EventType, { label: string; color: string; dot: string }> = {
	exec: { label: 'exec', color: 'text-emerald-300', dot: 'bg-emerald-400' },
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

export function fmtTime(ts: string): string {
	const d = new Date(ts);
	return (
		d.toLocaleTimeString('en-GB', { hour12: false }) +
		'.' +
		String(d.getMilliseconds()).padStart(3, '0')
	);
}
