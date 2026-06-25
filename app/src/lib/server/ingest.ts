import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IngestEvent, KestrelEvent } from '$lib/schema/event';
import { db, schema, dbReady, DEFAULT_ACCOUNT_ID } from './db';
import { publish } from './hub';

/** hostname → host.id cache, so we don't hit the DB for every event. */
const hostCache = new Map<string, string>();

async function resolveHostId(hostname: string): Promise<string> {
	const cached = hostCache.get(hostname);
	if (cached) {
		await db.update(schema.hosts).set({ lastSeen: new Date() }).where(eq(schema.hosts.id, cached));
		return cached;
	}

	const found = await db
		.select({ id: schema.hosts.id })
		.from(schema.hosts)
		.where(eq(schema.hosts.hostname, hostname));

	let id = found[0]?.id;
	if (!id) {
		id = randomUUID();
		await db.insert(schema.hosts).values({ id, accountId: DEFAULT_ACCOUNT_ID, hostname });
	}

	hostCache.set(hostname, id);
	return id;
}

function normalize(e: IngestEvent): KestrelEvent {
	return {
		...e,
		id: e.id ?? randomUUID(),
		ts: e.ts ?? new Date().toISOString()
	};
}

/**
 * Persist a validated batch of events and fan them out to the live hub.
 * Callers MUST have already parsed the input through `ingestBatchSchema`
 * ("validate at the boundary").
 */
export async function ingestEvents(batch: IngestEvent[]): Promise<KestrelEvent[]> {
	await dbReady;

	const normalized = batch.map(normalize);
	if (normalized.length === 0) return normalized;

	const rows = await Promise.all(
		normalized.map(async (e) => ({
			id: e.id,
			hostId: await resolveHostId(e.host),
			ts: e.ts,
			type: e.type,
			pid: e.pid,
			ppid: e.ppid,
			uid: e.uid,
			user: e.user,
			comm: e.comm,
			exe: e.exe,
			cmdline: e.cmdline,
			containerId: e.container_id ?? null,
			filePath: e.file_path,
			flags: e.flags,
			destIp: e.dest_ip,
			destPort: e.dest_port,
			proto: e.proto
		}))
	);

	await db.insert(schema.events).values(rows);

	for (const e of normalized) publish(e);
	return normalized;
}
