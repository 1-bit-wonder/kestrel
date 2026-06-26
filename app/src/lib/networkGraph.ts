import type { KestrelEvent } from '$lib/schema/event';
import { procName } from '$lib/eventMeta';

/**
 * Network-map builder (SPEC §8.3) — pure and client-safe, so it can be unit
 * tested and reused on either side of the wire (SSR seed + live client), just
 * like {@link buildProcessTree}. Layout (the force simulation) lives in the
 * NetworkMap component; this only produces the deterministic graph data.
 *
 * The graph is bipartite: process nodes on one side, destination (ip:port)
 * nodes on the other, joined by an edge per process→destination pair. Edge and
 * node `count`s tally how many connections fed them, so the view can size/weight
 * busy talkers. Derived purely from `net_connect` events — every other type is
 * ignored.
 */

export interface NetNode {
	id: string;
	kind: 'process' | 'dest';
	label: string;
	/** Total connect events touching this node — used to size it. */
	count: number;

	// process nodes
	pid?: number;
	comm?: string;
	user?: string;

	// destination nodes
	ip?: string;
	port?: number;
	proto?: string;
}

export interface NetEdge {
	id: string;
	source: string; // process node id
	target: string; // destination node id
	count: number;
}

export interface NetworkGraph {
	nodes: NetNode[];
	edges: NetEdge[];
}

const procId = (pid: number) => `p:${pid}`;
const destId = (ip: string, port: number) => `d:${ip}:${port}`;

/**
 * Fold a list of events (any order) into the process↔destination graph. A
 * process is keyed by pid; for the network map's live-snapshot purpose pid is a
 * good-enough identity (pid reuse is handled properly by the process-tree
 * builder, not needed here). `comm` is the accurate process name at connect time
 * (the task image has already switched, unlike at exec — see procName).
 */
export function buildNetworkGraph(events: KestrelEvent[]): NetworkGraph {
	const procs = new Map<string, NetNode>();
	const dests = new Map<string, NetNode>();
	const edges = new Map<string, NetEdge>();

	for (const e of events) {
		if (e.type !== 'net_connect' || !e.dest_ip) continue;
		const port = e.dest_port ?? 0;
		const pId = procId(e.pid);
		const dId = destId(e.dest_ip, port);

		let p = procs.get(pId);
		if (!p) {
			p = {
				id: pId,
				kind: 'process',
				label: procName(e),
				count: 0,
				pid: e.pid,
				comm: e.comm,
				user: e.user
			};
			procs.set(pId, p);
		} else if (e.exe) {
			p.label = procName(e); // a later event with an exe sharpens the name.
		}
		p.count++;

		let d = dests.get(dId);
		if (!d) {
			d = {
				id: dId,
				kind: 'dest',
				label: `${e.dest_ip}:${port}`,
				count: 0,
				ip: e.dest_ip,
				port,
				proto: e.proto
			};
			dests.set(dId, d);
		}
		d.count++;

		const eId = `${pId}->${dId}`;
		let ed = edges.get(eId);
		if (!ed) {
			ed = { id: eId, source: pId, target: dId, count: 0 };
			edges.set(eId, ed);
		}
		ed.count++;
	}

	return {
		nodes: [...procs.values(), ...dests.values()],
		edges: [...edges.values()]
	};
}
