import { json, error } from '@sveltejs/kit';
import { ingestBatchSchema } from '$lib/schema/event';
import { ingestEvents } from '$lib/server/ingest';
import type { RequestHandler } from './$types';

/**
 * Ingest endpoint (SPEC §7). The Go agent POSTs batches of kernel events here.
 * Every event is Zod-parsed before it touches the DB or the hub.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON body');
	}

	const parsed = ingestBatchSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, JSON.stringify(parsed.error.flatten()));
	}

	const stored = await ingestEvents(parsed.data);
	return json({ accepted: stored.length }, { status: 202 });
};
