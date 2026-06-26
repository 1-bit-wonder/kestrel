import { describe, expect, it } from 'vitest';
import type { KestrelEvent } from '$lib/schema/event';
import { buildProcessTree, countNodes, type ProcNode } from './processTree';

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

function find(roots: ProcNode[], pid: number): ProcNode | undefined {
	const stack = [...roots];
	while (stack.length) {
		const n = stack.pop()!;
		if (n.pid === pid) return n;
		stack.push(...n.children);
	}
	return undefined;
}

describe('buildProcessTree', () => {
	it('links children to parents via ppid', () => {
		const roots = buildProcessTree([
			ev({ pid: 1, type: 'exec', comm: 'systemd' }),
			ev({ pid: 10, ppid: 1, type: 'exec', comm: 'bash' }),
			ev({ pid: 11, ppid: 10, type: 'exec', comm: 'curl' })
		]);

		expect(roots).toHaveLength(1);
		expect(roots[0].pid).toBe(1);
		expect(roots[0].children.map((c) => c.pid)).toEqual([10]);
		expect(find(roots, 10)!.children.map((c) => c.pid)).toEqual([11]);
		expect(countNodes(roots)).toBe(3);
	});

	it('treats a process whose parent was never seen as a root', () => {
		const roots = buildProcessTree([ev({ pid: 50, ppid: 49, type: 'exec', comm: 'orphan' })]);
		expect(roots).toHaveLength(1);
		expect(roots[0].pid).toBe(50);
	});

	it('marks a process exited and records exit time', () => {
		const roots = buildProcessTree([
			ev({ pid: 10, type: 'exec', comm: 'bash', ts: '2026-06-25T12:00:00.000Z' }),
			ev({ pid: 10, type: 'exit', comm: 'bash', ts: '2026-06-25T12:00:05.000Z' })
		]);
		expect(roots[0].exited).toBe(true);
		expect(roots[0].exitedAt).toBe('2026-06-25T12:00:05.000Z');
	});

	it('tallies activity events per process', () => {
		const roots = buildProcessTree([
			ev({ pid: 10, type: 'exec', comm: 'curl' }),
			ev({ pid: 10, type: 'net_connect', comm: 'curl', dest_ip: '1.1.1.1', dest_port: 53 }),
			ev({ pid: 10, type: 'net_connect', comm: 'curl', dest_ip: '8.8.8.8', dest_port: 53 }),
			ev({ pid: 10, type: 'file_open', comm: 'curl', file_path: '/etc/hosts' })
		]);
		expect(roots[0].counts).toEqual({ net_connect: 2, file_open: 1 });
	});

	it('names a process by its exe basename, not the spawning shell comm', () => {
		// At sys_enter_execve the kernel comm is still the caller (the shell);
		// the real program is in exe. The node must show `nano`, not `bash`.
		const roots = buildProcessTree([
			ev({ pid: 10, ppid: 1, type: 'exec', comm: 'bash', exe: '/usr/bin/nano' })
		]);
		expect(roots[0].name).toBe('nano');
		expect(roots[0].comm).toBe('bash');
	});

	it('starts a fresh generation when an exited pid is reused', () => {
		const roots = buildProcessTree([
			ev({ pid: 10, type: 'exec', comm: 'bash', ts: '2026-06-25T12:00:00.000Z' }),
			ev({ pid: 10, type: 'exit', comm: 'bash', ts: '2026-06-25T12:00:01.000Z' }),
			ev({ pid: 10, type: 'exec', comm: 'python3', ts: '2026-06-25T12:00:30.000Z' })
		]);
		expect(roots[0].comm).toBe('python3');
		expect(roots[0].exited).toBe(false);
		expect(roots[0].firstSeen).toBe('2026-06-25T12:00:30.000Z');
	});

	it('does not loop on a ppid cycle from pid reuse', () => {
		const roots = buildProcessTree([
			ev({ pid: 1, ppid: 2, type: 'exec' }),
			ev({ pid: 2, ppid: 1, type: 'exec' })
		]);
		// Both resolve without infinite recursion; total node count is preserved.
		expect(countNodes(roots)).toBe(2);
	});
});
