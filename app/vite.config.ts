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
		// The agent ships to a HARDCODED 10.0.2.2:5173, so the app MUST be on
		// 5173. Without strictPort, Vite silently bumps to 5174 when 5173 is held
		// (e.g. a lingering dev server) — and then the agent posts into the void
		// and any open dashboard tab errors against the dead port. Fail loudly
		// instead so the stale process gets cleared.
		port: 5173,
		strictPort: true,
		watch: {
			// The PGlite data dir is written continuously by the ingest path; if
			// Vite watches it, every event triggers a full-page reload. Ignore it
			// (and any stray sqlite files) so the live feed streams smoothly.
			ignored: ['**/kestrel-pgdata/**', '**/*.db', '**/*.db-*']
		}
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// Force an ephemeral in-memory PGlite for every test file so tests never
		// read or mutate the on-disk dev DB (./kestrel-pgdata). Set as an env var
		// (not per-file) because the `db` singleton reads DATABASE_URL when its
		// module is first evaluated — which, with hoisted ESM imports, can happen
		// before a per-file assignment runs.
		env: { DATABASE_URL: 'memory://' }
	}
});
