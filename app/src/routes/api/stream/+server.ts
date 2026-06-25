import { subscribe } from '$lib/server/hub';
import type { KestrelEvent } from '$lib/schema/event';
import type { RequestHandler } from './$types';

/**
 * Live event stream (SPEC §7 "live hub") over Server-Sent Events. The feed
 * page subscribes here; the ingest endpoint publishes into the same hub.
 *
 * Optional `?type=exec,file_open` query filter narrows the stream server-side.
 */
export const GET: RequestHandler = ({ url }) => {
	const typeParam = url.searchParams.get('type');
	const typeFilter = typeParam
		? new Set(
				typeParam
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			)
		: null;

	let unsubscribe: () => void = () => {};
	let heartbeat: ReturnType<typeof setInterval>;

	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (data: string) => {
				try {
					controller.enqueue(enc.encode(data));
				} catch {
					// Stream already closed; cleanup runs in cancel().
				}
			};

			send(`retry: 2000\n\n`);
			send(`event: ready\ndata: {}\n\n`);

			const onEvent = (event: KestrelEvent) => {
				if (typeFilter && !typeFilter.has(event.type)) return;
				send(`event: kestrel\ndata: ${JSON.stringify(event)}\n\n`);
			};
			unsubscribe = subscribe(onEvent);

			// Keep proxies/load-balancers from idling the connection shut.
			heartbeat = setInterval(() => send(`: ping\n\n`), 15000);
		},
		cancel() {
			unsubscribe();
			clearInterval(heartbeat);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
