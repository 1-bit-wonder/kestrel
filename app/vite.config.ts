import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
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
