import type { EventType, KestrelEvent } from '$lib/schema/event';
import { procName } from '$lib/eventMeta';

/**
 * Process-tree builder (SPEC §8.2) — pure and client-safe so it can be unit
 * tested in isolation and reused on either side of the wire.
 *
 * The tree is DERIVED from the event stream rather than shipped as a snapshot
 * by the agent: every `exec` carries `pid`/`ppid`, so the parent→child forest
 * falls out of the events the app already stores (SPEC §7 anticipates an
 * app-side `processes` materialized view). `exit` events complete a process's
 * lifetime so the view can distinguish running from finished processes.
 *
 * Caveat — PID reuse: the kernel recycles PIDs. We treat an `exec` for a PID we
 * already saw *exit* as a new process generation (reset its lifetime/activity);
 * an `exec` for a still-running PID is treated as a re-`exec` (image swap, e.g.
 * a shell exec'ing a binary) and keeps the original start time.
 */

/** Per-PID activity tallies, used for the drill-down badges. */
export type ActivityCounts = Partial<Record<EventType, number>>;

export interface ProcNode {
	pid: number;
	ppid?: number;
	/** Display name: the executed binary's basename when known, else `comm`.
	 *  (At exec, kernel `comm` is the spawning shell — see procName.) */
	name: string;
	comm: string;
	exe?: string;
	cmdline?: string;
	uid?: number;
	user?: string;
	/** ISO ts of the exec that started this process (or first time we saw it). */
	firstSeen: string;
	/** ISO ts of the most recent event attributed to this PID. */
	lastActivity: string;
	exited: boolean;
	exitedAt?: string;
	/** Counts of activity events (file_open, net_connect, …) by this PID. */
	counts: ActivityCounts;
	children: ProcNode[];
}

function freshNode(e: KestrelEvent): ProcNode {
	return {
		pid: e.pid,
		ppid: e.ppid,
		name: procName(e),
		comm: e.comm,
		exe: e.exe,
		cmdline: e.cmdline,
		uid: e.uid,
		user: e.user,
		firstSeen: e.ts,
		lastActivity: e.ts,
		exited: false,
		counts: {},
		children: []
	};
}

/** Refresh a node's identity from a newer event (exec carries the best data). */
function applyIdentity(n: ProcNode, e: KestrelEvent): void {
	n.comm = e.comm;
	n.name = procName(e);
	if (e.ppid !== undefined) n.ppid = e.ppid;
	if (e.exe !== undefined) n.exe = e.exe;
	if (e.cmdline !== undefined) n.cmdline = e.cmdline;
	if (e.uid !== undefined) n.uid = e.uid;
	if (e.user !== undefined) n.user = e.user;
}

/**
 * Build a parent→child forest from a list of events (any order). Returns the
 * root nodes; each node's `children` are sorted by start time then PID.
 */
export function buildProcessTree(events: KestrelEvent[]): ProcNode[] {
	const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	const nodes = new Map<number, ProcNode>();

	for (const e of sorted) {
		let n = nodes.get(e.pid);
		if (!n) {
			n = freshNode(e);
			nodes.set(e.pid, n);
		}

		if (e.type === 'exec') {
			if (n.exited) {
				// PID reuse — start a fresh generation.
				n = freshNode(e);
				nodes.set(e.pid, n);
			} else {
				applyIdentity(n, e);
			}
		} else if (e.type === 'exit') {
			n.exited = true;
			n.exitedAt = e.ts;
		} else {
			n.counts[e.type] = (n.counts[e.type] ?? 0) + 1;
		}

		if (e.ts > n.lastActivity) n.lastActivity = e.ts;
	}

	// Link children to parents; a node whose parent we never observed is a root.
	const roots: ProcNode[] = [];
	for (const n of nodes.values()) {
		const parent = n.ppid !== undefined ? nodes.get(n.ppid) : undefined;
		if (parent && parent !== n && !createsCycle(n, parent, nodes)) {
			parent.children.push(n);
		} else {
			roots.push(n);
		}
	}

	const byStart = (a: ProcNode, b: ProcNode) =>
		a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : a.pid - b.pid;
	for (const n of nodes.values()) n.children.sort(byStart);
	roots.sort(byStart);
	return roots;
}

/** Would making `parent` the parent of `n` close a loop? (guards PID reuse) */
function createsCycle(n: ProcNode, parent: ProcNode, nodes: Map<number, ProcNode>): boolean {
	let cur: ProcNode | undefined = parent;
	const seen = new Set<number>();
	while (cur) {
		if (cur.pid === n.pid) return true;
		if (seen.has(cur.pid)) return true;
		seen.add(cur.pid);
		cur = cur.ppid !== undefined ? nodes.get(cur.ppid) : undefined;
	}
	return false;
}

/** Total number of nodes across a forest (for summaries/tests). */
export function countNodes(roots: ProcNode[]): number {
	let total = 0;
	const walk = (n: ProcNode) => {
		total++;
		n.children.forEach(walk);
	};
	roots.forEach(walk);
	return total;
}
