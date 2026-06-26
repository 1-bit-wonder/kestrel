import { EVENT_TYPES, type EventType, type KestrelEvent } from '$lib/schema/event';
import { procName } from '$lib/eventMeta';

/**
 * Host-overview aggregation (SPEC §8.6) — pure and client-safe so the
 * one-screen status numbers are unit-testable and deterministic given a clock.
 *
 * Operates on a recent slice of events; the caller decides how many to fetch.
 */

/** Aggregate / liveness window: counts and busiest are over the last 5 minutes. */
export const OVERVIEW_WINDOW_MS = 5 * 60_000;

/**
 * The event-rate sparkline is a SEPARATE, shorter window than the aggregate
 * counts: a tight 60s of 1s buckets so it visibly scrolls left every tick.
 * (A 5min/30-bucket sparkline only shifts once per 10s — it reads as frozen.)
 */
export const SPARKLINE_WINDOW_MS = 60_000;
export const SPARKLINE_BUCKETS = 60;

export interface BusyProc {
	comm: string;
	count: number;
}

export interface OverviewStats {
	/** Events within the aggregate window. */
	totalEvents: number;
	/** Aggregate window (counts/busiest), in seconds. */
	windowSeconds: number;
	/** Sparkline window, in seconds (its buckets span this, not windowSeconds). */
	sparkSeconds: number;
	/** Width of one sparkline bucket, in seconds. */
	bucketSeconds: number;
	/** Per-bucket event counts over the sparkline window (oldest → newest). */
	sparkline: number[];
	/** Average events/sec over the last 60s. */
	eventsPerSec: number;
	byType: Record<EventType, number>;
	/** Processes seen exec'd whose last lifecycle event was not an exit. */
	activeProcesses: number;
	/** Distinct destination IPs among net_connect events. */
	connections: number;
	/** Placeholder until the rule engine lands (Phase 3, SPEC §8.5). */
	alertsLastHour: number;
	busiest: BusyProc[];
	lastEventTs?: string;
}

function emptyByType(): Record<EventType, number> {
	return Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<EventType, number>;
}

export interface OverviewOpts {
	windowMs?: number;
	sparkMs?: number;
	sparkBuckets?: number;
	topN?: number;
}

export function computeOverview(
	events: KestrelEvent[],
	nowMs: number,
	opts: OverviewOpts = {}
): OverviewStats {
	const windowMs = opts.windowMs ?? OVERVIEW_WINDOW_MS;
	const sparkMs = opts.sparkMs ?? SPARKLINE_WINDOW_MS;
	const sparkBuckets = opts.sparkBuckets ?? SPARKLINE_BUCKETS;
	const topN = opts.topN ?? 5;
	const bucketMs = sparkMs / sparkBuckets;
	const windowStart = nowMs - windowMs;

	// Sparkline buckets are snapped to a fixed wall-clock grid (multiples of
	// bucketMs), not to `now`. That's what stops peaks from wobbling between
	// adjacent buckets each tick: a given event always lands in the same slot,
	// and as `now` crosses a boundary the whole array shifts left by exactly one.
	const newestBucket = Math.floor(nowMs / bucketMs);
	const oldestBucket = newestBucket - sparkBuckets + 1;

	const byType = emptyByType();
	const sparkline = new Array<number>(sparkBuckets).fill(0);
	const nameCounts = new Map<string, number>();
	const destIps = new Set<string>();

	// Process liveness in arrival order so the last lifecycle event per PID wins.
	const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	const alive = new Map<number, boolean>();

	let totalEvents = 0;
	let eventsLast60s = 0;
	let lastEventTs: string | undefined;

	for (const e of sorted) {
		const tMs = Date.parse(e.ts);
		if (!lastEventTs || e.ts > lastEventTs) lastEventTs = e.ts;

		if (e.type === 'exec') alive.set(e.pid, true);
		else if (e.type === 'exit') alive.set(e.pid, false);

		// Sparkline window (last `sparkMs`) is a subset of the aggregate window.
		const bucket = Math.floor(tMs / bucketMs) - oldestBucket;
		if (bucket >= 0 && bucket < sparkBuckets) sparkline[bucket]++;

		if (tMs < windowStart) continue;

		totalEvents++;
		byType[e.type]++;
		nameCounts.set(procName(e), (nameCounts.get(procName(e)) ?? 0) + 1);
		if (e.type === 'net_connect' && e.dest_ip) destIps.add(e.dest_ip);
		if (tMs >= nowMs - 60_000) eventsLast60s++;
	}

	let activeProcesses = 0;
	for (const isAlive of alive.values()) if (isAlive) activeProcesses++;

	const busiest = [...nameCounts.entries()]
		.map(([comm, count]) => ({ comm, count }))
		.sort((a, b) => b.count - a.count || a.comm.localeCompare(b.comm))
		.slice(0, topN);

	return {
		totalEvents,
		windowSeconds: Math.round(windowMs / 1000),
		sparkSeconds: Math.round(sparkMs / 1000),
		bucketSeconds: Math.round(bucketMs / 1000),
		sparkline,
		eventsPerSec: Math.round((eventsLast60s / 60) * 100) / 100,
		byType,
		activeProcesses,
		connections: destIps.size,
		alertsLastHour: 0,
		busiest,
		lastEventTs
	};
}
