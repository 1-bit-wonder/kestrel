import type { IngestEvent } from '$lib/schema/event';
import { ingestEvents } from './ingest';

/**
 * Synthetic event generator — stands in for the real Go/eBPF agent so the
 * dashboard is demoable end-to-end WITHOUT the dev VM (the agent must run on a
 * real kernel; CLAUDE.md Golden Rule #1). It fabricates plausible kernel
 * events and pushes them through the same ingest path the agent will use.
 *
 * Opt-in: enable with KESTREL_SYNTHETIC=1 (e.g. to demo the dashboard without
 * the agent/VM). Off otherwise, so mock data is never confused with real events.
 */

const HOST = 'kestrel-dev';
const USERS: Array<[number, string]> = [
	[0, 'root'],
	[1000, 'ni'],
	[33, 'www-data']
];

const EXECS = [
	{ comm: 'bash', exe: '/usr/bin/bash', cmdline: 'bash -i' },
	{ comm: 'curl', exe: '/usr/bin/curl', cmdline: 'curl https://example.com/x' },
	{ comm: 'node', exe: '/usr/bin/node', cmdline: 'node server.js' },
	{ comm: 'sshd', exe: '/usr/sbin/sshd', cmdline: 'sshd: [accepted]' },
	{ comm: 'nginx', exe: '/usr/sbin/nginx', cmdline: 'nginx: worker process' },
	{ comm: 'cron', exe: '/usr/sbin/cron', cmdline: '/usr/sbin/cron -f' },
	{ comm: 'python3', exe: '/usr/bin/python3', cmdline: 'python3 -c import os' }
];

const FILES = [
	'/etc/shadow',
	'/etc/passwd',
	'/home/ni/.ssh/id_ed25519',
	'/var/log/auth.log',
	'/tmp/.x',
	'/etc/nginx/nginx.conf'
];

const DESTS = [
	{ ip: '140.82.121.4', port: 443 },
	{ ip: '1.1.1.1', port: 53 },
	{ ip: '10.0.0.5', port: 5432 },
	{ ip: '185.199.108.153', port: 443 },
	{ ip: '45.33.32.156', port: 4444 } // looks like a C2 — fun for the rule engine later
];

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const randPid = () => 1000 + Math.floor(Math.random() * 60000);

function makeEvent(): IngestEvent {
	const [uid, user] = pick(USERS);
	const base = {
		host: HOST,
		pid: randPid(),
		ppid: randPid(),
		uid,
		user
	};
	const roll = Math.random();

	if (roll < 0.55) {
		const e = pick(EXECS);
		return { ...base, type: 'exec', ...e };
	}
	if (roll < 0.75) {
		const e = pick(EXECS);
		return {
			...base,
			type: 'file_open',
			comm: e.comm,
			exe: e.exe,
			file_path: pick(FILES),
			flags: Math.random() < 0.5 ? 'O_RDONLY' : 'O_RDWR'
		};
	}
	if (roll < 0.92) {
		const e = pick(EXECS);
		const d = pick(DESTS);
		return {
			...base,
			type: 'net_connect',
			comm: e.comm,
			exe: e.exe,
			dest_ip: d.ip,
			dest_port: d.port,
			proto: 'tcp'
		};
	}
	const e = pick(EXECS);
	return {
		...base,
		type: 'listen',
		comm: e.comm,
		exe: e.exe,
		dest_port: pick([22, 80, 443, 8080, 31337]),
		proto: 'tcp'
	};
}

let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
	const burst = 1 + Math.floor(Math.random() * 3);
	try {
		await ingestEvents(Array.from({ length: burst }, makeEvent));
	} catch (err) {
		console.error('[kestrel] synthetic ingest failed', err);
	}
	timer = setTimeout(tick, 400 + Math.random() * 1100);
}

export function startSyntheticSource(): void {
	if (timer) return; // guard against SvelteKit dev double-import
	timer = setTimeout(tick, 500);
	console.log('[kestrel] synthetic event source started (KESTREL_SYNTHETIC=1)');
}
