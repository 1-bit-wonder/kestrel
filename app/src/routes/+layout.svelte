<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="min-h-screen font-mono">
	<header class="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
			<img src="/favicon.svg" alt="" class="h-6 w-6" />
			<span class="text-lg font-bold tracking-tight text-emerald-400">Kestrel</span>
			<span class="text-xs text-zinc-500">single-host eBPF runtime security</span>
			<nav class="ml-auto flex gap-4 text-sm text-zinc-400">
				<a class="hover:text-zinc-100" href="/">Live feed</a>
			</nav>
		</div>
	</header>
	<main class="mx-auto max-w-6xl px-4 py-6">
		{@render children()}
	</main>
</div>
