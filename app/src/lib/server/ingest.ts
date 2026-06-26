import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IngestEvent, KestrelEvent } from '$lib/schema/event';
import { db, schema, dbReady, DEFAULT_ACCOUNT_ID } from './db';
import { publish } from './hub';

/** hostname → host.id cache, so we don't hit the DB for every event. */
const hostCache = new Map<string, string>();
/** hostname → last `lastSeen` bump (ms), so we throttle that write. */
const lastSeenAt = new Map<string, number>();
const LAST_SEEN_INTERVAL_MS = 5000;

async function resolveHostId(hostname: string): Promise<string> {
	let id = hostCache.get(hostname);
	if (!id) {
		const found = await db
			.select({ id: schema.hosts.id })
			.from(schema.hosts)
			.where(eq(schema.hosts.hostname, hostname));

		id = found[0]?.id;
		if (!id) {
			id = randomUUID();
			await db.insert(schema.hosts).values({ id, accountId: DEFAULT_ACCOUNT_ID, hostname });
		}
		hostCache.set(hostname, id);
	}

	// Bump lastSeen at most once per interval, fire-and-forget — keeping it off
	// the ingest hot path. Doing it per event serializes an UPDATE per event
	// through PGlite's single connection and starves the live stream under load.
	const now = Date.now();
	if (now - (lastSeenAt.get(hostname) ?? 0) >= LAST_SEEN_INTERVAL_MS) {
		lastSeenAt.set(hostname, now);
		void db
			.update(schema.hosts)
			.set({ lastSeen: new Date() })
			.where(eq(schema.hosts.id, id))
			.catch(() => {
				// A missed lastSeen bump is cosmetic; never let it break ingest.
			});
	}

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

	// Resolve host ids once per distinct hostname (a batch is almost always one
	// host), not once per event — the latter serialized a DB round-trip per
	// event and was the ingest bottleneck under a real host's exec rate.
	const hostIds = new Map<string, string>();
	for (const e of normalized) {
		if (!hostIds.has(e.host)) hostIds.set(e.host, await resolveHostId(e.host));
	}

	const rows = normalized.map((e) => ({
		id: e.id,
		hostId: hostIds.get(e.host)!,
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
	}));

	await db.insert(schema.events).values(rows);

	for (const e of normalized) publish(e);
	return normalized;
}
