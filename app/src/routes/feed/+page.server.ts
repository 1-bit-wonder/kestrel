import { getRecentEvents } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Seed the feed with recent history; live updates arrive over SSE.
	return { recent: await getRecentEvents(100) };
};
