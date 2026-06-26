<script lang="ts">
	import { EVENT_TYPES, type EventType, type KestrelEvent } from '$lib/schema/event';
	import { TYPE_META, eventDetail, fmtTime } from '$lib/eventMeta';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const MAX = 300;

	// Seed once from the server load; live events are appended via SSE below.
	// svelte-ignore state_referenced_locally
	let events = $state<KestrelEvent[]>([...data.recent]);
	let active = $state<Set<EventType>>(new Set(EVENT_TYPES));
	let paused = $state(false);
	let connected = $state(false);
	let received = $state(0);

	// While paused, new events accumulate in this plain (non-reactive) holder so
	// the table doesn't re-render; they're flushed on resume so nothing is lost.
	// `buffered` mirrors the count for the button badge.
	const held: { items: KestrelEvent[] } = { items: [] };
	let buffered = $state(0);

	const visible = $derived(events.filter((e) => active.has(e.type)));

	function toggle(t: EventType) {
		const next = new Set(active);
		if (next.has(t)) next.delete(t);
		else next.add(t);
		active = next;
	}

	function togglePause() {
		paused = !paused;
		if (!paused && held.items.length) {
			events = [...held.items, ...events].slice(0, MAX);
			held.items = [];
			buffered = 0;
		}
	}

	$effect(() => {
		const es = new EventSource('/api/stream');
		es.addEventListener('ready', () => (connected = true));
		es.addEventListener('kestrel', (ev) => {
			received++;
			const event = JSON.parse((ev as MessageEvent).data) as KestrelEvent;
			if (paused) {
				held.items = [event, ...held.items].slice(0, MAX);
				buffered = held.items.length;
				return;
			}
			events = [event, ...events].slice(0, MAX);
		});
		es.onerror = () => (connected = false);
		return () => es.close();
	});
</script>

<div class="flex items-center gap-3 pb-4">
	<h1 class="text-xl font-semibold">Live activity feed</h1>
	<span
		class="inline-flex items-center gap-1.5 text-xs"
		class:text-ember={connected}
		class:text-ktext-mute={!connected}
	>
		<span class="h-2 w-2 rounded-full" class:bg-ember={connected} class:bg-hairline-2={!connected}
		></span>
		{connected ? 'streaming' : 'disconnected'}
	</span>
	<span class="text-xs text-ktext-mute">{received} events received</span>

	<button
		class="ml-auto rounded border px-3 py-1 text-xs transition-colors"
		class:border-warn={paused}
		class:text-warn={paused}
		class:border-hairline-2={!paused}
		class:hover:bg-surface-2={!paused}
		onclick={togglePause}
	>
		{#if paused}▶ Resume{buffered ? ` (${buffered})` : ''}{:else}⏸ Pause{/if}
	</button>
</div>

<div class="flex flex-wrap gap-2 pb-4">
	{#each EVENT_TYPES as t (t)}
		<button
			class="rounded-full border px-3 py-1 text-xs transition-colors"
			class:border-hairline={!active.has(t)}
			class:text-ktext-mute={!active.has(t)}
			class:border-hairline-2={active.has(t)}
			class:bg-surface-2={active.has(t)}
			onclick={() => toggle(t)}
		>
			<span class="mr-1 inline-block h-2 w-2 rounded-full {TYPE_META[t].dot}"></span>
			{TYPE_META[t].label}
		</button>
	{/each}
</div>

<div class="rounded-lg border border-hairline">
	<div class="h-[70vh] overflow-y-auto">
		<table class="w-full table-fixed text-left text-sm">
			<colgroup>
				<col class="w-32" />
				<col class="w-24" />
				<col class="w-40" />
				<col class="w-20" />
				<col class="w-28" />
				<col />
			</colgroup>
			<thead class="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-ktext-mute">
				<tr>
					<th class="px-3 py-2 font-medium">Time</th>
					<th class="px-3 py-2 font-medium">Type</th>
					<th class="px-3 py-2 font-medium">Process</th>
					<th class="px-3 py-2 font-medium">PID</th>
					<th class="px-3 py-2 font-medium">User</th>
					<th class="px-3 py-2 font-medium">Detail</th>
				</tr>
			</thead>
			<tbody>
				{#each visible as e (e.id)}
					<tr class="border-t border-hairline/70 hover:bg-surface/50">
						<td class="truncate px-3 py-1.5 text-ktext-mute tabular-nums">{fmtTime(e.ts)}</td>
						<td class="px-3 py-1.5">
							<span class="inline-flex items-center gap-1.5 {TYPE_META[e.type].color}">
								<span class="h-1.5 w-1.5 shrink-0 rounded-full {TYPE_META[e.type].dot}"></span>
								{TYPE_META[e.type].label}
							</span>
						</td>
						<td class="truncate px-3 py-1.5 text-ktext">{e.comm}</td>
						<td class="truncate px-3 py-1.5 text-ktext-mute tabular-nums">{e.pid}</td>
						<td class="truncate px-3 py-1.5 text-ktext-mute">{e.user ?? e.uid ?? '—'}</td>
						<td class="truncate px-3 py-1.5 text-ktext-mute" title={eventDetail(e)}>
							{eventDetail(e)}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="6" class="px-3 py-8 text-center text-ktext-faint">
							Waiting for events…
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
