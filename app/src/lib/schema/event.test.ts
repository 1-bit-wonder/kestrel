import { describe, expect, it } from 'vitest';
import { ingestBatchSchema, ingestEventSchema } from './event';

const baseExec = {
	host: 'h1',
	type: 'exec',
	pid: 1234,
	comm: 'bash'
};

describe('ingestEventSchema', () => {
	it('accepts a minimal exec event (id/ts optional)', () => {
		const r = ingestEventSchema.safeParse(baseExec);
		expect(r.success).toBe(true);
	});

	it('rejects an unknown event type', () => {
		const r = ingestEventSchema.safeParse({ ...baseExec, type: 'mystery' });
		expect(r.success).toBe(false);
	});

	it('requires file_path for file_open', () => {
		const ok = ingestEventSchema.safeParse({
			...baseExec,
			type: 'file_open',
			file_path: '/etc/shadow'
		});
		const bad = ingestEventSchema.safeParse({ ...baseExec, type: 'file_open' });
		expect(ok.success).toBe(true);
		expect(bad.success).toBe(false);
	});

	it('requires dest_ip and dest_port for net_connect', () => {
		const bad = ingestEventSchema.safeParse({
			...baseExec,
			type: 'net_connect',
			dest_ip: '1.2.3.4'
		});
		const ok = ingestEventSchema.safeParse({
			...baseExec,
			type: 'net_connect',
			dest_ip: '1.2.3.4',
			dest_port: 443,
			proto: 'tcp'
		});
		expect(bad.success).toBe(false);
		expect(ok.success).toBe(true);
	});

	it('rejects an out-of-range port', () => {
		const r = ingestEventSchema.safeParse({
			...baseExec,
			type: 'net_connect',
			dest_ip: '1.2.3.4',
			dest_port: 70000
		});
		expect(r.success).toBe(false);
	});

	it('rejects a negative pid', () => {
		const r = ingestEventSchema.safeParse({ ...baseExec, pid: -1 });
		expect(r.success).toBe(false);
	});
});

describe('ingestBatchSchema', () => {
	it('accepts a bare array', () => {
		const r = ingestBatchSchema.safeParse([baseExec, baseExec]);
		expect(r.success).toBe(true);
		if (r.success) expect(r.data).toHaveLength(2);
	});

	it('accepts and unwraps an { events } envelope', () => {
		const r = ingestBatchSchema.safeParse({ events: [baseExec] });
		expect(r.success).toBe(true);
		if (r.success) expect(r.data).toHaveLength(1);
	});
});
