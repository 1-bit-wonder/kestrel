<script lang="ts">
	import { page } from '$app/state';
	import '../app.css';
	let { children } = $props();

	const NAV = [
		{ href: '/', label: 'Overview' },
		{ href: '/feed', label: 'Live feed' },
		{ href: '/processes', label: 'Processes' },
		{ href: '/network', label: 'Network' }
	];
</script>

<div class="min-h-screen font-mono">
	<header class="border-b border-hairline bg-surface/60 backdrop-blur">
		<div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
			<img src="/favicon.svg" alt="" class="h-6 w-6" />
			<span class="font-sans text-lg font-bold tracking-tight text-strike">kestrel</span>
			<span class="text-xs text-ktext-mute">single-host eBPF runtime security</span>
			<nav class="ml-auto flex gap-4 text-sm">
				{#each NAV as item (item.href)}
					{@const active =
						item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
					<a
						class="transition-colors hover:text-ktext"
						class:text-strike={active}
						class:text-ktext-mute={!active}
						href={item.href}>{item.label}</a
					>
				{/each}
			</nav>
		</div>
	</header>
	<main class="mx-auto max-w-6xl px-4 py-6">
		{@render children()}
	</main>
</div>
