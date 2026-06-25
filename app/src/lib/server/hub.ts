import type { KestrelEvent } from '$lib/schema/event';

/**
 * In-process pub/sub hub for the live feed. The ingest endpoint publishes
 * normalized events here; the SSE endpoint (`/api/stream`) subscribes and
 * forwards them to connected dashboards.
 *
 * In-memory by design for v1 (single host, single app process). A multi-host
 * or multi-process deployment would swap this for Postgres LISTEN/NOTIFY or a
 * message broker — the publish/subscribe surface stays the same.
 */

export type Subscriber = (event: KestrelEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function publish(event: KestrelEvent): void {
	for (const fn of subscribers) {
		try {
			fn(event);
		} catch {
			// A failing subscriber must not break the fan-out to the others.
		}
	}
}

export function subscriberCount(): number {
	return subscribers.size;
}
