<script lang="ts">
	// A tiny inline-SVG event-rate histogram. Bars (not a line) because the data
	// is discrete per-second event counts that are mostly sparse — a line chart
	// zig-zags to a flat baseline and reads as "broken/empty", whereas bars show
	// quiet seconds as honest gaps and a single event as a clear tick. Hand-rolled
	// (rather than a chart lib) — the "lightweight time-series" slot in the stack
	// (SPEC §3); D3 is reserved for the process/network graphs.
	let {
		data,
		width = 160,
		height = 32,
		fill = 'currentColor'
	}: { data: number[]; width?: number; height?: number; fill?: string } = $props();

	const max = $derived(Math.max(1, ...data));

	const bars = $derived.by(() => {
		const n = data.length;
		if (n === 0) return [];
		const slot = width / n;
		const gap = Math.min(2, slot * 0.3);
		const barW = Math.max(1, slot - gap);
		const pad = 1;
		const innerH = height - pad;
		return data.map((v, i) => {
			// A non-zero bucket always shows at least a 2px tick so a lone event is
			// visible even next to a tall peak.
			const h = v === 0 ? 0 : Math.max(2, (v / max) * innerH);
			return { x: i * slot, y: height - h, w: barW, h };
		});
	});
</script>

<!-- width/height props are the internal COORDINATE space; the element itself
     stretches to fill its container (preserveAspectRatio="none") so the chart is
     always full-bleed regardless of panel width. -->
<svg
	viewBox="0 0 {width} {height}"
	width="100%"
	{height}
	preserveAspectRatio="none"
	class="block"
	role="img"
	aria-label="event rate, peak {max} per second"
>
	{#each bars as b, i (i)}
		{#if b.h > 0}
			<rect x={b.x} y={b.y} width={b.w} height={b.h} rx="0.75" {fill} />
		{/if}
	{/each}
</svg>
