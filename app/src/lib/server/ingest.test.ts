// Use an isolated in-memory PGlite DB for this test file (set before importing
// the db singleton, which reads DATABASE_URL at module load).
process.env.DATABASE_URL = 'memory://';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { KestrelEvent } from '$lib/schema/event';
import { ingestEvents } from './ingest';
import { subscribe } from './hub';
import { db, schema, dbReady } from './db';

beforeAll(async () => {
	await dbReady;
});

afterEach(async () => {
	await db.delete(schema.events);
});

describe('ingestEvents', () => {
	it('stamps id/ts, persists rows, and resolves a host', async () => {
		const out = await ingestEvents([{ host: 'box-a', type: 'exec', pid: 10, comm: 'bash' }]);

		expect(out).toHaveLength(1);
		expect(out[0].id).toMatch(/[0-9a-f-]{36}/);
		expect(out[0].ts).toBeTruthy();

		const rows = await db.select().from(schema.events);
		expect(rows).toHaveLength(1);
		expect(rows[0].comm).toBe('bash');

		const hosts = await db.select().from(schema.hosts);
		expect(hosts.some((h) => h.hostname === 'box-a')).toBe(true);
	});

	it('publishes each ingested event to the hub', async () => {
		const seen: KestrelEvent[] = [];
		const unsub = subscribe((e) => seen.push(e));

		await ingestEvents([
			{
				host: 'box-b',
				type: 'net_connect',
				pid: 5,
				comm: 'curl',
				dest_ip: '1.1.1.1',
				dest_port: 53
			}
		]);
		unsub();

		expect(seen).toHaveLength(1);
		expect(seen[0].dest_ip).toBe('1.1.1.1');
	});

	it('reuses the same host id for repeated hostnames', async () => {
		await ingestEvents([{ host: 'box-c', type: 'exec', pid: 1, comm: 'a' }]);
		await ingestEvents([{ host: 'box-c', type: 'exec', pid: 2, comm: 'b' }]);

		const hosts = (await db.select().from(schema.hosts)).filter((h) => h.hostname === 'box-c');
		expect(hosts).toHaveLength(1);
	});
});
