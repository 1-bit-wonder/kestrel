import { desc, eq } from 'drizzle-orm';
import type { KestrelEvent } from '$lib/schema/event';
import { buildProcessTree, type ProcNode } from '$lib/processTree';
import { computeOverview, type OverviewStats } from '$lib/overview';
import { db, schema, dbReady } from './db';
import type { EventRow } from './db/schema';

/** Reverse the ingest mapping: a DB row → the wire/UI event shape. */
export function rowToEvent(row: EventRow, hostname: string): KestrelEvent {
	return {
		id: row.id,
		ts: row.ts,
		host: hostname,
		type: row.type as KestrelEvent['type'],
		pid: row.pid,
		ppid: row.ppid ?? undefined,
		uid: row.uid ?? undefined,
		user: row.user ?? undefined,
		comm: row.comm,
		exe: row.exe ?? undefined,
		cmdline: row.cmdline ?? undefined,
		container_id: row.containerId,
		file_path: row.filePath ?? undefined,
		flags: row.flags ?? undefined,
		dest_ip: row.destIp ?? undefined,
		dest_port: row.destPort ?? undefined,
		proto: (row.proto as KestrelEvent['proto']) ?? undefined
	};
}

/** Most recent events, newest first — initial payload for the live feed. */
export async function getRecentEvents(limit = 100): Promise<KestrelEvent[]> {
	await dbReady;
	const rows = await db
		.select({ event: schema.events, hostname: schema.hosts.hostname })
		.from(schema.events)
		.innerJoin(schema.hosts, eq(schema.events.hostId, schema.hosts.id))
		.orderBy(desc(schema.events.ts))
		.limit(limit);

	return rows.map((r) => rowToEvent(r.event, r.hostname));
}

/**
 * Recent process-tree forest (SPEC §8.2), derived from the stored event stream.
 * We pull a generous slice of recent events so parent execs are present for the
 * children we show; the builder assembles the parent→child hierarchy.
 */
export async function getProcessTree(limit = 3000): Promise<ProcNode[]> {
	const events = await getRecentEvents(limit);
	return buildProcessTree(events);
}

/** One-screen host status (SPEC §8.6), computed from a recent event slice. */
export async function getOverview(limit = 5000): Promise<OverviewStats> {
	const events = await getRecentEvents(limit);
	return computeOverview(events, Date.now());
}
