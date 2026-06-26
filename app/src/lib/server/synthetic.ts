import type { IngestEvent } from '$lib/schema/event';
import { ingestEvents } from './ingest';

/**
 * Synthetic event generator — stands in for the real Go/eBPF agent so the
 * dashboard is demoable end-to-end WITHOUT the dev VM (the agent must run on a
 * real kernel; CLAUDE.md Golden Rule #1). It fabricates plausible kernel
 * events and pushes them through the same ingest path the agent will use.
 *
 * Unlike a naive random emitter, this maintains a *coherent live process set*:
 * new processes are spawned as children of existing ones (so pid/ppid chains
 * form a real tree for the process explorer, SPEC §8.2), processes emit file
 * and network activity, and they eventually exit (so liveness and lifetimes in
 * the host overview, SPEC §8.6, are meaningful).
 *
 * Opt-in: enable with KESTREL_SYNTHETIC=1. Off otherwise, so mock data is never
 * confused with real events.
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
	{ comm: 'python3', exe: '/usr/bin/python3', cmdline: 'python3 -c import os' },
	{ comm: 'git', exe: '/usr/bin/git', cmdline: 'git fetch origin' },
	{ comm: 'sh', exe: '/usr/bin/sh', cmdline: 'sh -c ./run' },
	{ comm: 'ls', exe: '/usr/bin/ls', cmdline: 'ls -la' }
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
const chance = (p: number) => Math.random() < p;

interface Proc {
	pid: number;
	ppid: number;
	comm: string;
	exe: string;
	cmdline: string;
	uid: number;
	user: string;
	persistent: boolean; // long-lived service roots that never exit
}

let nextPid = 1000;
const live = new Map<number, Proc>();

function identity(p: Proc) {
	return {
		host: HOST,
		pid: p.pid,
		ppid: p.ppid,
		uid: p.uid,
		user: p.user,
		comm: p.comm,
		exe: p.exe
	};
}

/** Seed a few long-lived service roots so the tree always has a backbone. */
function seed() {
	if (live.size) return;
	const systemd: Proc = {
		pid: 1,
		ppid: 0,
		comm: 'systemd',
		exe: '/usr/lib/systemd/systemd',
		cmdline: '/sbin/init',
		uid: 0,
		user: 'root',
		persistent: true
	};
	live.set(1, systemd);
	for (const svc of [
		{ comm: 'sshd', exe: '/usr/sbin/sshd', cmdline: '/usr/sbin/sshd -D', uid: 0, user: 'root' },
		{ comm: 'nginx', exe: '/usr/sbin/nginx', cmdline: 'nginx: master', uid: 0, user: 'root' },
		{ comm: 'cron', exe: '/usr/sbin/cron', cmdline: '/usr/sbin/cron -f', uid: 0, user: 'root' }
	]) {
		const p: Proc = { pid: nextPid++, ppid: 1, persistent: true, ...svc };
		live.set(p.pid, p);
	}
}

function spawnChild(): IngestEvent {
	const parents = [...live.values()];
	const parent = pick(parents);
	const tmpl = pick(EXECS);
	// A child usually inherits its parent's user; occasionally drops privileges.
	const [uid, user] = chance(0.7) ? [parent.uid, parent.user] : pick(USERS);
	const child: Proc = {
		pid: nextPid++,
		ppid: parent.pid,
		comm: tmpl.comm,
		exe: tmpl.exe,
		cmdline: tmpl.cmdline,
		uid,
		user,
		persistent: false
	};
	live.set(child.pid, child);
	return { ...identity(child), type: 'exec', cmdline: child.cmdline };
}

function activity(p: Proc): IngestEvent {
	const roll = Math.random();
	if (roll < 0.4) {
		return {
			...identity(p),
			type: 'file_open',
			file_path: pick(FILES),
			flags: chance(0.5) ? 'O_RDONLY' : 'O_RDWR'
		};
	}
	if (roll < 0.8) {
		const d = pick(DESTS);
		return { ...identity(p), type: 'net_connect', dest_ip: d.ip, dest_port: d.port, proto: 'tcp' };
	}
	return {
		...identity(p),
		type: 'listen',
		dest_port: pick([22, 80, 443, 8080, 31337]),
		proto: 'tcp'
	};
}

function exitProc(p: Proc): IngestEvent {
	live.delete(p.pid);
	return { ...identity(p), type: 'exit' };
}

function buildBatch(): IngestEvent[] {
	seed();
	const batch: IngestEvent[] = [];

	// Spawn 1–2 new processes as children of the live set.
	const spawns = 1 + (chance(0.4) ? 1 : 0);
	for (let i = 0; i < spawns; i++) batch.push(spawnChild());

	// A few live processes do some work this tick.
	const workers = [...live.values()];
	const acts = 1 + Math.floor(Math.random() * 3);
	for (let i = 0; i < acts; i++) batch.push(activity(pick(workers)));

	// Occasionally retire a non-persistent process (its children become roots).
	const mortal = [...live.values()].filter((p) => !p.persistent);
	if (mortal.length > 8 || (mortal.length && chance(0.4))) {
		batch.push(exitProc(pick(mortal)));
	}

	return batch;
}

let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
	try {
		await ingestEvents(buildBatch());
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
