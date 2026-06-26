<script lang="ts">
	import type { KestrelEvent } from '$lib/schema/event';
	import { buildNetworkGraph, type NetworkGraph, type NetNode } from '$lib/networkGraph';
	import NetworkMap from '$lib/components/NetworkMap.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const MAX_BUFFER = 2000;
	// Only net_connect events feed the map; the builder ignores the rest, but we
	// pre-filter so the rolling buffer holds only what matters.
	// svelte-ignore state_referenced_locally
	const buffer: KestrelEvent[] = data.seed.filter((e) => e.type === 'net_connect');
	// svelte-ignore state_referenced_locally
	let graph = $state<NetworkGraph>(buildNetworkGraph(buffer));
	let connected = $state(false);
	let selectedId = $state<string | null>(null);

	function rebuild() {
		if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
		graph = buildNetworkGraph(buffer);
	}

	// Drill-down: the selected node plus its neighbours, derived from the graph.
	const detail = $derived.by(() => {
		if (selectedId === null) return null;
		const node = graph.nodes.find((n) => n.id === selectedId);
		if (!node) return null;
		const neighbours =
			node.kind === 'process'
				? graph.edges
						.filter((e) => e.source === node.id)
						.map((e) => ({ node: graph.nodes.find((n) => n.id === e.target)!, count: e.count }))
				: graph.edges
						.filter((e) => e.target === node.id)
						.map((e) => ({ node: graph.nodes.find((n) => n.id === e.source)!, count: e.count }));
		neighbours.sort((a, b) => b.count - a.count);
		return { node, neighbours: neighbours.filter((n) => n.node) };
	});

	const stats = $derived({
		processes: graph.nodes.filter((n) => n.kind === 'process').length,
		dests: graph.nodes.filter((n) => n.kind === 'dest').length,
		edges: graph.edges.length
	});

	$effect(() => {
		const es = new EventSource('/api/stream?type=net_connect');
		es.addEventListener('ready', () => (connected = true));
		es.addEventListener('kestrel', (ev) => {
			buffer.push(JSON.parse((ev as MessageEvent).data) as KestrelEvent);
		});
		es.onerror = () => (connected = false);
		const iv = setInterval(rebuild, 1500);
		return () => {
			es.close();
			clearInterval(iv);
		};
	});
</script>

<div class="flex items-center gap-3 pb-4">
	<h1 class="text-xl font-semibold">Network map</h1>
	<span
		class="inline-flex items-center gap-1.5 text-xs"
		class:text-ember={connected}
		class:text-ktext-mute={!connected}
	>
		<span class="h-2 w-2 rounded-full" class:bg-ember={connected} class:bg-hairline-2={!connected}
		></span>
		{connected ? 'live' : 'disconnected'}
	</span>
	<span class="ml-auto flex items-center gap-3 text-xs text-ktext-mute">
		<span class="inline-flex items-center gap-1.5"
			><span class="h-2 w-2 rounded-full bg-ember"></span>process</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="h-2 w-2 rounded-full bg-info"></span>destination</span
		>
	</span>
</div>

<div class="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_18rem]">
	<NetworkMap {graph} {selectedId} onselect={(n) => (selectedId = n.id)} />

	<!-- Drill-down: "why is THAT process talking to THAT address?" (SPEC §8.3) -->
	<aside class="rounded-lg border border-hairline bg-surface/40 p-4 text-sm">
		{#if detail}
			<div class="flex items-baseline gap-2 pb-1">
				<span class="break-all text-base font-semibold text-ktext">{detail.node.label}</span>
			</div>
			<div class="pb-3 text-xs text-ktext-mute">
				{detail.node.kind === 'process' ? 'process' : 'destination'} · {detail.node.count} connection{detail
					.node.count === 1
					? ''
					: 's'}
			</div>
			<dl class="space-y-1.5 text-xs">
				{#if detail.node.kind === 'process'}
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">pid</dt>
						<dd class="tabular-nums text-ktext-dim">{detail.node.pid}</dd>
					</div>
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">comm</dt>
						<dd class="text-ktext-dim">{detail.node.comm}</dd>
					</div>
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">user</dt>
						<dd class="text-ktext-dim">{detail.node.user ?? '—'}</dd>
					</div>
				{:else}
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">ip</dt>
						<dd class="break-all text-ktext-dim">{detail.node.ip}</dd>
					</div>
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">port</dt>
						<dd class="tabular-nums text-ktext-dim">{detail.node.port}</dd>
					</div>
					<div class="flex justify-between gap-2">
						<dt class="text-ktext-mute">proto</dt>
						<dd class="text-ktext-dim">{detail.node.proto ?? '—'}</dd>
					</div>
				{/if}
			</dl>

			<div class="mt-3">
				<div class="pb-1 text-xs text-ktext-mute">
					{detail.node.kind === 'process' ? 'talks to' : 'talked to by'}
				</div>
				<ul class="space-y-1">
					{#each detail.neighbours as nb (nb.node.id)}
						<li class="flex items-center gap-2 text-xs">
							<span
								class="h-1.5 w-1.5 rounded-full {nb.node.kind === 'process'
									? 'bg-ember'
									: 'bg-info'}"
							></span>
							<button
								class="truncate text-left text-ktext-dim hover:text-ktext"
								onclick={() => (selectedId = nb.node.id)}>{nb.node.label}</button
							>
							<span class="ml-auto tabular-nums text-ktext-mute">{nb.count}</span>
						</li>
					{/each}
				</ul>
			</div>
		{:else}
			<div class="pb-3 text-xs text-ktext-mute">
				{stats.processes} processes · {stats.dests} destinations · {stats.edges} edges
			</div>
			<div class="py-8 text-center text-ktext-faint">Select a node to inspect it.</div>
		{/if}
	</aside>
</div>
