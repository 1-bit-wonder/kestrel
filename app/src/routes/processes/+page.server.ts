import { getRecentEvents } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Return a recent event slice; the page builds the parent→child forest with
	// the same pure builder used here, so SSR and the live client agree and the
	// tree updates as exec/exit events stream in (SPEC §8.2).
	return { seed: await getRecentEvents(2000) };
};
