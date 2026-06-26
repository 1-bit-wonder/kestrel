import { z } from 'zod';

/**
 * The agent↔app event contract (SPEC §6).
 *
 * This file is the SINGLE SOURCE OF TRUTH for the event shape. The Go agent
 * must emit JSON that validates against `ingestEventSchema`. Every event
 * entering the ingest endpoint is parsed here before it touches the DB or the
 * rule engine ("validate at the boundary" — CLAUDE.md).
 */

export const EVENT_TYPES = [
	'exec', // process executed (the spine)
	'exit', // process exited — completes a process lifetime (8.2 tree liveness)
	'file_open', // file opened — sensitive-file monitor
	'net_connect', // outbound connection — network map
	'listen', // new listening socket
	'priv_change', // setuid/setgid — privilege escalation signal
	'module_load' // kernel module loaded — tampering signal
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const PROTOCOLS = ['tcp', 'udp'] as const;
export const protocolSchema = z.enum(PROTOCOLS);

/**
 * Fields common to every event, plus the optional type-specific fields. We
 * keep this flat (rather than a discriminated union) so it maps 1:1 onto the
 * flat `events` table for cheap querying by the dashboard views — required
 * type-specific fields are enforced by `superRefine` below.
 *
 * `id` and `ts` are optional on the wire: the agent MAY supply them, but the
 * ingest endpoint will assign them if absent so the agent stays simple.
 */
const baseFields = {
	id: z.string().uuid().optional(),
	ts: z.string().datetime({ offset: true }).optional(),
	host: z.string().min(1),
	type: eventTypeSchema,

	// process identity (present on all kernel events)
	pid: z.number().int().nonnegative(),
	ppid: z.number().int().nonnegative().optional(),
	uid: z.number().int().nonnegative().optional(),
	user: z.string().optional(),
	comm: z.string().min(1),
	exe: z.string().optional(),
	cmdline: z.string().optional(),
	container_id: z.string().nullable().optional(),

	// type-specific — file_open
	file_path: z.string().optional(),
	flags: z.string().optional(),

	// type-specific — net_connect / listen
	dest_ip: z.string().optional(),
	dest_port: z.number().int().min(0).max(65535).optional(),
	proto: protocolSchema.optional()
};

function requireFields(val: Record<string, unknown>, ctx: z.RefinementCtx, fields: string[]) {
	for (const f of fields) {
		if (val[f] === undefined || val[f] === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `'${f}' is required for type '${val.type}'`,
				path: [f]
			});
		}
	}
}

/** The wire schema: what the agent POSTs to the ingest endpoint. */
export const ingestEventSchema = z.object(baseFields).superRefine((val, ctx) => {
	switch (val.type) {
		case 'file_open':
			requireFields(val, ctx, ['file_path']);
			break;
		case 'net_connect':
			requireFields(val, ctx, ['dest_ip', 'dest_port']);
			break;
	}
});

export type IngestEvent = z.infer<typeof ingestEventSchema>;

/** A batch of events (the agent ships batches, not one-at-a-time). */
export const ingestBatchSchema = z.union([
	z.array(ingestEventSchema),
	z.object({ events: z.array(ingestEventSchema) }).transform((b) => b.events)
]);

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/**
 * A normalized event after ingest has stamped id/ts — this is what flows out
 * over SSE to the dashboard and what gets persisted.
 */
export type KestrelEvent = IngestEvent & { id: string; ts: string };
