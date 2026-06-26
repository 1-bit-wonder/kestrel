<script lang="ts">
	import { onMount } from 'svelte';
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCenter,
		forceCollide,
		forceX,
		forceY,
		type Simulation
	} from 'd3-force';
	import type { NetworkGraph, NetNode } from '$lib/networkGraph';

	let {
		graph,
		width = 760,
		height = 520,
		selectedId = null,
		onselect
	}: {
		graph: NetworkGraph;
		width?: number;
		height?: number;
		selectedId?: string | null;
		onselect?: (n: NetNode) => void;
	} = $props();

	// d3-force mutates node objects with x/y/vx/vy in place. We keep the objects
	// in a persistent map so the layout PERSISTS across live rebuilds (a new event
	// nudges the graph rather than reshuffling it), and bump `tick` each
	// simulation step to drive Svelte re-render (it can't see the in-place x/y
	// mutation otherwise). D3 = layout math, Svelte = DOM — same split as the tree.
	type SimNode = NetNode & { x: number; y: number; vx?: number; vy?: number };
	type SimLink = { id: string; source: SimNode | string; target: SimNode | string; count: number };

	const nodeById = new Map<string, SimNode>();
	let sim: Simulation<SimNode, SimLink> | null = null;
	let nodes = $state<SimNode[]>([]);
	let links = $state<SimLink[]>([]);
	let tick = $state(0);
	let mounted = $state(false);

	function radius(n: { kind: NetNode['kind']; count: number }): number {
		return (n.kind === 'process' ? 7 : 5) + Math.min(9, Math.sqrt(n.count) * 1.6);
	}

	function reconcile(g: NetworkGraph): void {
		const seen = new Set<string>();
		const simNodes: SimNode[] = [];
		let i = 0;
		for (const n of g.nodes) {
			seen.add(n.id);
			let s = nodeById.get(n.id);
			if (s) {
				// Refresh display fields; leave position/velocity for the sim.
				s.label = n.label;
				s.count = n.count;
				s.comm = n.comm;
				s.user = n.user;
			} else {
				// Seed new nodes on a small golden-angle spiral near centre — stable
				// (no Math.random) so there's no hydration surprise and the sim only
				// has to relax, not untangle a random pile.
				const a = i * 2.399963;
				s = { ...n, x: width / 2 + Math.cos(a) * 24, y: height / 2 + Math.sin(a) * 24 };
				nodeById.set(n.id, s);
			}
			simNodes.push(s);
			i++;
		}
		for (const id of [...nodeById.keys()]) if (!seen.has(id)) nodeById.delete(id);

		const simLinks: SimLink[] = g.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			count: e.count
		}));

		nodes = simNodes;
		links = simLinks;

		if (!sim) {
			sim = forceSimulation<SimNode>(simNodes)
				.force('charge', forceManyBody<SimNode>().strength(-260))
				.force(
					'link',
					forceLink<SimNode, SimLink>(simLinks)
						.id((d) => d.id)
						.distance(90)
						.strength(0.5)
				)
				.force('center', forceCenter(width / 2, height / 2))
				.force(
					'collide',
					forceCollide<SimNode>((d) => radius(d) + 4)
				)
				.force('x', forceX<SimNode>(width / 2).strength(0.04))
				.force('y', forceY<SimNode>(height / 2).strength(0.04))
				.on('tick', () => tick++);
		} else {
			sim.nodes(simNodes);
			sim.force(
				'link',
				forceLink<SimNode, SimLink>(simLinks)
					.id((d) => d.id)
					.distance(90)
					.strength(0.5)
			);
			sim.alpha(0.6).restart();
		}
	}

	onMount(() => {
		mounted = true;
		return () => sim?.stop();
	});

	// Re-run the layout whenever the graph prop changes — client-only (the
	// simulation needs the browser; SSR shows the placeholder below).
	$effect(() => {
		void graph;
		if (mounted) reconcile(graph);
	});

	// Resolved geometry, recomputed every tick (reads the d3-mutated x/y).
	const view = $derived.by(() => {
		void tick;
		const segs = links
			.map((l) => {
				const s = typeof l.source === 'object' ? l.source : nodeById.get(l.source);
				const t = typeof l.target === 'object' ? l.target : nodeById.get(l.target);
				if (!s || !t) return null;
				return {
					id: l.id,
					x1: s.x,
					y1: s.y,
					x2: t.x,
					y2: t.y,
					w: Math.min(4, 0.6 + Math.log2(l.count + 1))
				};
			})
			.filter((x): x is NonNullable<typeof x> => x !== null);
		const pts = nodes.map((n) => ({ n, x: n.x, y: n.y, r: radius(n) }));
		return { segs, pts };
	});
</script>

{#if view.pts.length === 0}
	<div
		class="flex h-[520px] items-center justify-center rounded-lg border border-hairline bg-surface/30 text-ktext-faint"
	>
		No outbound connections yet — waiting for net_connect events…
	</div>
{:else}
	<div class="rounded-lg border border-hairline bg-surface/30">
		<svg viewBox="0 0 {width} {height}" class="block w-full" role="img" aria-label="Network map">
			<g>
				{#each view.segs as s (s.id)}
					<line
						x1={s.x1}
						y1={s.y1}
						x2={s.x2}
						y2={s.y2}
						class="stroke-hairline-2"
						stroke-width={s.w}
						opacity="0.7"
					/>
				{/each}
			</g>
			<g>
				{#each view.pts as p (p.n.id)}
					{@const sel = p.n.id === selectedId}
					<g
						class="cursor-pointer"
						transform="translate({p.x},{p.y})"
						role="button"
						tabindex="0"
						onclick={() => onselect?.(p.n)}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onselect?.(p.n)}
					>
						<circle
							r={p.r}
							class:fill-ember={p.n.kind === 'process'}
							class:fill-info={p.n.kind === 'dest'}
							class:stroke-strike={sel}
							stroke-width={sel ? 2.5 : 0}
							opacity="0.9"
						/>
						<text
							x={p.r + 4}
							y="3.5"
							class="pointer-events-none text-[10px]"
							class:fill-ktext={sel}
							class:fill-ktext-mute={!sel}
						>
							{p.n.label}
						</text>
					</g>
				{/each}
			</g>
		</svg>
	</div>
{/if}
