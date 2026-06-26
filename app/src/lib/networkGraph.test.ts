import { describe, expect, it } from 'vitest';
import type { KestrelEvent } from '$lib/schema/event';
import { buildNetworkGraph, type NetNode } from './networkGraph';

let seq = 0;
function ev(p: Partial<KestrelEvent> & { pid: number; type: KestrelEvent['type'] }): KestrelEvent {
	seq++;
	return {
		id: `e${seq}`,
		ts: p.ts ?? `2026-06-25T12:00:${String(seq).padStart(2, '0')}.000Z`,
		host: 'h',
		comm: p.comm ?? 'proc',
		...p
	};
}

const conn = (pid: number, ip: string, port: number, extra: Partial<KestrelEvent> = {}) =>
	ev({ pid, type: 'net_connect', dest_ip: ip, dest_port: port, proto: 'tcp', ...extra });

const node = (g: { nodes: NetNode[] }, id: string) => g.nodes.find((n) => n.id === id);

describe('buildNetworkGraph', () => {
	it('builds process and destination nodes joined by an edge', () => {
		const g = buildNetworkGraph([conn(100, '1.1.1.1', 53, { comm: 'curl' })]);
		expect(node(g, 'p:100')).toMatchObject({ kind: 'process', label: 'curl', pid: 100 });
		expect(node(g, 'd:1.1.1.1:53')).toMatchObject({ kind: 'dest', ip: '1.1.1.1', port: 53 });
		expect(g.edges).toEqual([
			{ id: 'p:100->d:1.1.1.1:53', source: 'p:100', target: 'd:1.1.1.1:53', count: 1 }
		]);
	});

	it('ignores non-net_connect events entirely', () => {
		const g = buildNetworkGraph([
			ev({ pid: 1, type: 'exec', comm: 'bash' }),
			ev({ pid: 1, type: 'file_open', comm: 'bash', file_path: '/etc/shadow' }),
			ev({ pid: 1, type: 'exit', comm: 'bash' })
		]);
		expect(g.nodes).toHaveLength(0);
		expect(g.edges).toHaveLength(0);
	});

	it('aggregates repeated connections into edge/node counts', () => {
		const g = buildNetworkGraph([
			conn(100, '1.1.1.1', 53),
			conn(100, '1.1.1.1', 53),
			conn(100, '1.1.1.1', 53)
		]);
		expect(g.edges[0].count).toBe(3);
		expect(node(g, 'p:100')!.count).toBe(3);
		expect(node(g, 'd:1.1.1.1:53')!.count).toBe(3);
	});

	it('separates distinct ports on the same ip into distinct dest nodes', () => {
		const g = buildNetworkGraph([conn(100, '1.1.1.1', 53), conn(100, '1.1.1.1', 443)]);
		expect(node(g, 'd:1.1.1.1:53')).toBeDefined();
		expect(node(g, 'd:1.1.1.1:443')).toBeDefined();
		expect(g.edges).toHaveLength(2);
	});

	it('fans one destination out to multiple processes', () => {
		const g = buildNetworkGraph([
			conn(100, '10.0.0.5', 5432, { comm: 'node' }),
			conn(200, '10.0.0.5', 5432, { comm: 'python3' })
		]);
		expect(node(g, 'd:10.0.0.5:5432')!.count).toBe(2);
		expect(g.edges.map((e) => e.source).sort()).toEqual(['p:100', 'p:200']);
	});

	it('sharpens a process label when a later event carries an exe', () => {
		// net_connect from the real agent has no exe (comm is accurate post-exec),
		// but a synthetic/exec-carrying event with exe should win the basename.
		const g = buildNetworkGraph([
			conn(100, '1.1.1.1', 53, { comm: 'bash' }),
			conn(100, '1.1.1.1', 53, { comm: 'bash', exe: '/usr/bin/curl' })
		]);
		expect(node(g, 'p:100')!.label).toBe('curl');
	});
});
