<script lang="ts">
	import type { KestrelEvent } from '$lib/schema/event';
	import { buildProcessTree, type ProcNode } from '$lib/processTree';
	import { TYPE_META, fmtTime } from '$lib/eventMeta';
	import ProcessTree from '$lib/components/ProcessTree.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const MAX_BUFFER = 2000;
	// svelte-ignore state_referenced_locally
	const buffer: KestrelEvent[] = [...data.seed];
	// svelte-ignore state_referenced_locally
	let roots = $state<ProcNode[]>(buildProcessTree(buffer));
	let connected = $state(false);
	let selectedPid = $state<number | null>(null);

	function rebuild() {
		if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
		roots = buildProcessTree(buffer);
	}

	// Find the selected node anywhere in the forest for the drill-down panel.
	const selected = $derived.by(() => {
		if (selectedPid === null) return null;
		const stack = [...roots];
		while (stack.length) {
			const n = stack.pop()!;
			if (n.pid === selectedPid) return n;
			stack.push(...n.children);
		}
		return null;
	});

	function lifetime(p: ProcNode): string {
		const end = p.exitedAt ? Date.parse(p.exitedAt) : Date.now();
		const ms = end - Date.parse(p.firstSeen);
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}

	$effect(() => {
		const es = new EventSource('/api/stream');
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
	<h1 class="text-xl font-semibold">Process tree</h1>
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
	<span class="ml-auto flex items-center gap-3 text-xs text-zinc-500">
		<span class="inline-flex items-center gap-1.5"
			><span class="h-2 w-2 rounded-full bg-emerald-400"></span>running</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span class="h-2 w-2 rounded-full bg-zinc-600"></span>exited</span
		>
	</span>
</div>

<div class="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_18rem]">
	<ProcessTree {roots} {selectedPid} onselect={(p) => (selectedPid = p.pid)} />

	<!-- Drill-down panel (SPEC §8.2: click a node → its files, connections, lifetime) -->
	<aside class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
		{#if selected}
			<div class="flex items-baseline gap-2 pb-3">
				<span class="text-base font-semibold text-zinc-100">{selected.name}</span>
				<span class="tabular-nums text-zinc-500">pid {selected.pid}</span>
			</div>
			<dl class="space-y-1.5 text-xs">
				{#if selected.comm !== selected.name}
					<div class="flex justify-between gap-2">
						<dt class="text-zinc-500">spawned by</dt>
						<dd class="text-zinc-300">{selected.comm}</dd>
					</div>
				{/if}
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">status</dt>
					<dd class={selected.exited ? 'text-zinc-400' : 'text-emerald-300'}>
						{selected.exited ? 'exited' : 'running'}
					</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">lifetime</dt>
					<dd class="tabular-nums text-zinc-300">{lifetime(selected)}</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">user</dt>
					<dd class="text-zinc-300">{selected.user ?? selected.uid ?? '—'}</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">ppid</dt>
					<dd class="tabular-nums text-zinc-300">{selected.ppid ?? '—'}</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">children</dt>
					<dd class="tabular-nums text-zinc-300">{selected.children.length}</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="text-zinc-500">started</dt>
					<dd class="tabular-nums text-zinc-300">{fmtTime(selected.firstSeen)}</dd>
				</div>
			</dl>

			{#if selected.exe || selected.cmdline}
				<div class="mt-3 break-all rounded bg-zinc-950/60 p-2 font-mono text-[11px] text-zinc-400">
					{selected.cmdline ?? selected.exe}
				</div>
			{/if}

			{#if Object.keys(selected.counts).length}
				<div class="mt-3">
					<div class="pb-1 text-xs text-zinc-500">activity</div>
					<ul class="space-y-1">
						{#each Object.entries(selected.counts) as [type, count] (type)}
							<li class="flex items-center gap-2 text-xs">
								<span
									class="h-1.5 w-1.5 rounded-full {TYPE_META[type as keyof typeof TYPE_META].dot}"
								></span>
								<span class="text-zinc-400">{TYPE_META[type as keyof typeof TYPE_META].label}</span>
								<span class="ml-auto tabular-nums text-zinc-300">{count}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else}
			<div class="py-8 text-center text-zinc-600">Select a process to inspect it.</div>
		{/if}
	</aside>
</div>
