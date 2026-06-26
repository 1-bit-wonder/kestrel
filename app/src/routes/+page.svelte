<script lang="ts">
	import { EVENT_TYPES, type KestrelEvent } from '$lib/schema/event';
	import { computeOverview, OVERVIEW_WINDOW_MS, type OverviewStats } from '$lib/overview';
	import { TYPE_META } from '$lib/eventMeta';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Rolling buffer of recent events, seeded from the server load and kept live
	// over SSE. We recompute the whole overview from it so the numbers match the
	// pure server-side computation exactly (single source of truth).
	// svelte-ignore state_referenced_locally
	const buffer: KestrelEvent[] = [...data.seed];
	// svelte-ignore state_referenced_locally
	let stats = $state<OverviewStats>(data.overview);
	let connected = $state(false);

	function recompute() {
		const now = Date.now();
		// Drop anything older than the window so the buffer stays bounded.
		const cutoff = now - OVERVIEW_WINDOW_MS;
		while (buffer.length && Date.parse(buffer[0].ts) < cutoff) buffer.shift();
		stats = computeOverview(buffer, now);
	}

	$effect(() => {
		const es = new EventSource('/api/stream');
		es.addEventListener('ready', () => (connected = true));
		es.addEventListener('kestrel', (ev) => {
			buffer.push(JSON.parse((ev as MessageEvent).data) as KestrelEvent);
		});
		es.onerror = () => (connected = false);
		// Recompute on a steady tick so the sparkline slides and rates decay even
		// when no new events arrive.
		const iv = setInterval(recompute, 1000);
		return () => {
			es.close();
			clearInterval(iv);
		};
	});

	const cards = $derived([
		{ label: 'events / sec', value: stats.eventsPerSec, hint: 'last 60s' },
		{ label: 'active processes', value: stats.activeProcesses, hint: 'running' },
		{ label: 'connections', value: stats.connections, hint: 'distinct dest IPs' },
		{ label: 'alerts', value: stats.alertsLastHour, hint: 'last hour' }
	]);

	const maxBusy = $derived(Math.max(1, ...stats.busiest.map((b) => b.count)));
</script>

<div class="flex items-center gap-3 pb-4">
	<h1 class="text-xl font-semibold">Host overview</h1>
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
		{connected ? 'live' : 'disconnected'}
	</span>
</div>

<div class="grid grid-cols-2 gap-3 pb-4 sm:grid-cols-4">
	{#each cards as c (c.label)}
		<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
			<div class="text-2xl font-semibold tabular-nums text-zinc-100">{c.value}</div>
			<div class="text-xs text-zinc-400">{c.label}</div>
			<div class="text-[10px] uppercase tracking-wide text-zinc-600">{c.hint}</div>
		</div>
	{/each}
</div>

<div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
	<!-- Event rate sparkline -->
	<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 lg:col-span-2">
		<div class="flex items-baseline justify-between pb-2">
			<span class="text-sm text-zinc-300">Event rate</span>
			<span class="text-xs text-zinc-500">
				~{stats.eventsPerSec}/s · last {stats.sparkSeconds}s
			</span>
		</div>
		<div class="text-emerald-400">
			<Sparkline data={stats.sparkline} width={520} height={48} />
		</div>
	</div>

	<!-- Events by type -->
	<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
		<div class="pb-2 text-sm text-zinc-300">By type</div>
		<ul class="space-y-1 text-sm">
			{#each EVENT_TYPES as t (t)}
				<li class="flex items-center gap-2">
					<span class="h-1.5 w-1.5 rounded-full {TYPE_META[t].dot}"></span>
					<span class="text-zinc-400">{TYPE_META[t].label}</span>
					<span class="ml-auto tabular-nums text-zinc-300">{stats.byType[t]}</span>
				</li>
			{/each}
		</ul>
	</div>
</div>

<!-- Busiest processes -->
<div class="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
	<div class="pb-2 text-sm text-zinc-300">Busiest processes</div>
	{#if stats.busiest.length}
		<ul class="space-y-1.5">
			{#each stats.busiest as b (b.comm)}
				<li class="flex items-center gap-3 text-sm">
					<span class="w-32 truncate text-zinc-200">{b.comm}</span>
					<span class="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
						<span
							class="block h-full rounded bg-emerald-500/70"
							style="width: {(b.count / maxBusy) * 100}%"
						></span>
					</span>
					<span class="w-10 text-right tabular-nums text-zinc-400">{b.count}</span>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="py-4 text-center text-sm text-zinc-600">Waiting for events…</div>
	{/if}
</div>
