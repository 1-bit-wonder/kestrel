import { dev } from '$app/environment';
import { dbReady } from '$lib/server/db';
import { startSyntheticSource } from '$lib/server/synthetic';

// Ensure migrations + default account are applied before serving requests.
await dbReady;

const synthetic = process.env.KESTREL_SYNTHETIC ?? (dev ? '1' : '0');
if (synthetic === '1') {
	startSyntheticSource();
}
