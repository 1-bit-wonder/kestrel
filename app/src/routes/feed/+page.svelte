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
		class:text-emerald-400={connected}
		class:text-zinc-500={!connected}
	>
		<span
			class="h-2 w-2 rounded-full"
			class:bg-emerald-400={connected}
			class:bg-zinc-600={!connected}
		></span>
		{connected ? 'streaming' : 'disconnected'}
	</span>
	<span class="text-xs text-zinc-500">{received} events received</span>

	<button
		class="ml-auto rounded border px-3 py-1 text-xs transition-colors"
		class:border-amber-500={paused}
		class:text-amber-300={paused}
		class:border-zinc-700={!paused}
		class:hover:bg-zinc-800={!paused}
		onclick={togglePause}
	>
		{#if paused}▶ Resume{buffered ? ` (${buffered})` : ''}{:else}⏸ Pause{/if}
	</button>
</div>

<div class="flex flex-wrap gap-2 pb-4">
	{#each EVENT_TYPES as t (t)}
		<button
			class="rounded-full border px-3 py-1 text-xs transition-colors"
			class:border-zinc-700={!active.has(t)}
			class:text-zinc-500={!active.has(t)}
			class:border-zinc-500={active.has(t)}
			class:bg-zinc-800={active.has(t)}
			onclick={() => toggle(t)}
		>
			<span class="mr-1 inline-block h-2 w-2 rounded-full {TYPE_META[t].dot}"></span>
			{TYPE_META[t].label}
		</button>
	{/each}
</div>

<div class="rounded-lg border border-zinc-800">
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
			<thead class="sticky top-0 z-10 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
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
					<tr class="border-t border-zinc-800/70 hover:bg-zinc-900/50">
						<td class="truncate px-3 py-1.5 text-zinc-500 tabular-nums">{fmtTime(e.ts)}</td>
						<td class="px-3 py-1.5">
							<span class="inline-flex items-center gap-1.5 {TYPE_META[e.type].color}">
								<span class="h-1.5 w-1.5 shrink-0 rounded-full {TYPE_META[e.type].dot}"></span>
								{TYPE_META[e.type].label}
							</span>
						</td>
						<td class="truncate px-3 py-1.5 text-zinc-200">{e.comm}</td>
						<td class="truncate px-3 py-1.5 text-zinc-500 tabular-nums">{e.pid}</td>
						<td class="truncate px-3 py-1.5 text-zinc-400">{e.user ?? e.uid ?? '—'}</td>
						<td class="truncate px-3 py-1.5 text-zinc-400" title={eventDetail(e)}>
							{eventDetail(e)}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="6" class="px-3 py-8 text-center text-zinc-600"> Waiting for events… </td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
