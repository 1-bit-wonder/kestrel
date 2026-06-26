import { getRecentEvents } from '$lib/server/queries';
import { computeOverview, OVERVIEW_WINDOW_MS } from '$lib/overview';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// One-screen host status (SPEC §8.6). Computed server-side for an instant
	// first paint; the client keeps it live by recomputing from a rolling buffer
	// seeded with the current window's events and topped up over SSE.
	const events = await getRecentEvents(5000);
	const now = Date.now();
	const overview = computeOverview(events, now);
	const seed = events.filter((e) => Date.parse(e.ts) >= now - OVERVIEW_WINDOW_MS);
	return { overview, seed };
};
