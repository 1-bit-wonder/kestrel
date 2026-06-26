import { getRecentEvents } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Seed with a recent event slice; the page folds net_connect events into the
	// process↔destination graph with the same pure builder used elsewhere, and
	// keeps it live over SSE (SPEC §8.3). Non-net_connect events are ignored by
	// the builder, so passing the shared recent slice is harmless.
	return { seed: await getRecentEvents(2000) };
};
