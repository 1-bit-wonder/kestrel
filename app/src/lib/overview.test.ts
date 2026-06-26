import { describe, expect, it } from 'vitest';
import type { KestrelEvent } from '$lib/schema/event';
import { computeOverview } from './overview';

const NOW = Date.parse('2026-06-25T12:05:00.000Z');

let seq = 0;
function ev(
	p: Partial<KestrelEvent> & { pid: number; type: KestrelEvent['type']; ts: string }
): KestrelEvent {
	seq++;
	return { id: `e${seq}`, host: 'h', comm: p.comm ?? 'proc', ...p };
}

// Window is the last 5 minutes → [12:00:00, 12:05:00]. The 11:58 exec is out of
// window (excluded from counts) but still affects liveness.
const events: KestrelEvent[] = [
	ev({ pid: 3, type: 'exec', comm: 'sshd', ts: '2026-06-25T11:58:00.000Z' }),
	ev({ pid: 2, type: 'exec', comm: 'curl', ts: '2026-06-25T12:01:00.000Z' }),
	ev({
		pid: 2,
		type: 'file_open',
		comm: 'curl',
		file_path: '/etc/hosts',
		ts: '2026-06-25T12:01:00.000Z'
	}),
	ev({ pid: 1, type: 'exec', comm: 'bash', ts: '2026-06-25T12:04:30.000Z' }),
	ev({
		pid: 2,
		type: 'net_connect',
		comm: 'curl',
		dest_ip: '1.1.1.1',
		dest_port: 53,
		ts: '2026-06-25T12:04:51.000Z'
	}),
	ev({
		pid: 2,
		type: 'net_connect',
		comm: 'curl',
		dest_ip: '8.8.8.8',
		dest_port: 53,
		ts: '2026-06-25T12:04:52.000Z'
	}),
	ev({ pid: 1, type: 'exit', comm: 'bash', ts: '2026-06-25T12:04:55.000Z' })
];

describe('computeOverview', () => {
	const o = computeOverview(events, NOW);

	it('counts events by type within the window', () => {
		expect(o.byType.exec).toBe(2); // pid2, pid1 (pid3 is out of window)
		expect(o.byType.exit).toBe(1);
		expect(o.byType.net_connect).toBe(2);
		expect(o.byType.file_open).toBe(1);
		expect(o.totalEvents).toBe(6);
	});

	it('computes events/sec over the last 60s', () => {
		// 4 events at/after 12:04:00 (exec pid1, 2×net_connect, exit pid1); the
		// 12:01 exec/file_open for pid2 are older than 60s.
		expect(o.eventsPerSec).toBeCloseTo(4 / 60, 2);
	});

	it('counts processes still alive across the full stream', () => {
		// pid1 exec→exit (dead); pid2 alive; pid3 alive (out of window but unexited).
		expect(o.activeProcesses).toBe(2);
	});

	it('counts distinct destination IPs', () => {
		expect(o.connections).toBe(2);
	});

	it('ranks busiest processes by event count', () => {
		expect(o.busiest[0]).toEqual({ comm: 'curl', count: 4 });
		expect(o.busiest[1]).toEqual({ comm: 'bash', count: 2 });
	});

	it('buckets the last 60s into a fixed-length, wall-clock-aligned sparkline', () => {
		// Sparkline is its own short window (60×1s), not the 5min aggregate window.
		expect(o.sparkline).toHaveLength(60);
		// Its total is the last-60s event count (== eventsPerSec × 60), not totalEvents.
		expect(o.sparkline.reduce((a, b) => a + b, 0)).toBe(4);
		expect(o.sparkSeconds).toBe(60);
		expect(o.bucketSeconds).toBe(1);
	});

	it('reports zero alerts until the rule engine exists', () => {
		expect(o.alertsLastHour).toBe(0);
	});
});
