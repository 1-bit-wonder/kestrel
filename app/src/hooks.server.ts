import { dbReady } from '$lib/server/db';
import { startSyntheticSource } from '$lib/server/synthetic';

// Ensure migrations + default account are applied before serving requests.
await dbReady;

// The synthetic event generator is OPT-IN: it stands in for the agent so the
// dashboard is demoable without the VM, but it must be explicitly requested so
// its mock data is never mistaken for real events. Enable with KESTREL_SYNTHETIC=1.
if (process.env.KESTREL_SYNTHETIC === '1') {
	startSyntheticSource();
}
