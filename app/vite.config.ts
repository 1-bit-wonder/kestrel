import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		// Bind 0.0.0.0, not just loopback: in the dev VM the SvelteKit server
		// is reached over QEMU's port-forward (host:5173 → guest:5173), which
		// arrives on the guest's network interface — a loopback-only bind would
		// refuse it (the "spins forever" symptom). Harmless on the host too.
		host: true,
		watch: {
			// The PGlite data dir is written continuously by the ingest path; if
			// Vite watches it, every event triggers a full-page reload. Ignore it
			// (and any stray sqlite files) so the live feed streams smoothly.
			ignored: ['**/kestrel-pgdata/**', '**/*.db', '**/*.db-*']
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
