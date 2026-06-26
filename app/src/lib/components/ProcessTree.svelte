<script lang="ts">
	import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy';
	import type { ProcNode } from '$lib/processTree';

	let {
		roots,
		selectedPid = null,
		onselect
	}: {
		roots: ProcNode[];
		selectedPid?: number | null;
		onselect?: (p: ProcNode) => void;
	} = $props();

	// d3-hierarchy needs a single root; wrap the forest in a virtual node and
	// hide it (its children are our real roots, drawn disconnected).
	type Datum = { proc?: ProcNode; children?: Datum[] };
	const toDatum = (p: ProcNode): Datum => ({ proc: p, children: p.children.map(toDatum) });

	const ROW = 22; // px between sibling rows
	const COL = 200; // px between depth columns
	const PAD = 16;

	const layout = $derived.by(() => {
		const root = hierarchy<Datum>({ children: roots.map(toDatum) }, (d) => d.children);
		tree<Datum>().nodeSize([ROW, COL])(root);
		const points = root.descendants() as HierarchyPointNode<Datum>[];
		// Drop the virtual root (depth 0); real roots sit at depth 1.
		const nodes = points.filter((n) => n.depth >= 1);
		const xs = nodes.map((n) => n.x);
		const minX = Math.min(0, ...xs);
		const maxX = Math.max(0, ...xs);
		const maxDepth = Math.max(1, ...nodes.map((n) => n.depth));

		const sx = (n: HierarchyPointNode<Datum>) => (n.depth - 1) * COL + PAD;
		const sy = (n: HierarchyPointNode<Datum>) => n.x - minX + PAD;

		const links = nodes
			.filter((n) => n.depth >= 2 && n.parent)
			.map((n) => {
				const p = n.parent as HierarchyPointNode<Datum>;
				const x1 = sx(p);
				const y1 = sy(p);
				const x2 = sx(n);
				const y2 = sy(n);
				const mid = (x1 + x2) / 2;
				return { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` };
			});

		return {
			nodes: nodes.map((n) => ({ proc: n.data.proc!, x: sx(n), y: sy(n) })),
			links,
			width: maxDepth * COL + PAD * 2 + 120,
			height: maxX - minX + PAD * 2
		};
	});
</script>

{#if layout.nodes.length === 0}
	<div class="py-16 text-center text-zinc-600">No processes yet — waiting for exec events…</div>
{:else}
	<div class="overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/30">
		<svg width={layout.width} height={layout.height} class="block">
			<g>
				{#each layout.links as l (l.d)}
					<path d={l.d} fill="none" class="stroke-zinc-700" stroke-width="1" />
				{/each}
				{#each layout.nodes as n (n.proc.pid)}
					<g
						class="cursor-pointer"
						transform="translate({n.x},{n.y})"
						role="button"
						tabindex="0"
						onclick={() => onselect?.(n.proc)}
						onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onselect?.(n.proc)}
					>
						<circle
							r="4"
							class:fill-emerald-400={!n.proc.exited}
							class:fill-zinc-600={n.proc.exited}
							class:stroke-amber-300={n.proc.pid === selectedPid}
							stroke-width={n.proc.pid === selectedPid ? 2 : 0}
						/>
						<text
							x="9"
							y="3.5"
							class="text-[11px]"
							class:fill-zinc-200={!n.proc.exited}
							class:fill-zinc-500={n.proc.exited}
						>
							{n.proc.name}
							<tspan class="fill-zinc-600">·{n.proc.pid}</tspan>
						</text>
					</g>
				{/each}
			</g>
		</svg>
	</div>
{/if}
