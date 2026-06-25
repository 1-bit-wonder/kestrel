import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	driver: 'pglite',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? './kestrel-pgdata'
	}
});
