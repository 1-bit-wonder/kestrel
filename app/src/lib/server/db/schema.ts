import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Schema is multi-tenancy-ready even though v1 is single-host (CLAUDE.md
 * Golden Rule #5): an account owns hosts; hosts own events, rules, and alerts.
 * This keeps the SaaS option open at near-zero cost without baking in
 * single-host/single-user assumptions.
 *
 * Dev uses PGlite (WASM Postgres); prod uses Postgres — same dialect, so the
 * schema is identical across both.
 */

export const accounts = pgTable('accounts', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const hosts = pgTable('hosts', {
	id: text('id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id),
	hostname: text('hostname').notNull(),
	firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
	lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow()
});

export const events = pgTable(
	'events',
	{
		id: text('id').primaryKey(),
		hostId: text('host_id')
			.notNull()
			.references(() => hosts.id),
		// ISO-8601 timestamp from the kernel event (matches the Zod contract).
		ts: text('ts').notNull(),
		type: text('type').notNull(),

		// process identity
		pid: integer('pid').notNull(),
		ppid: integer('ppid'),
		uid: integer('uid'),
		user: text('user'),
		comm: text('comm').notNull(),
		exe: text('exe'),
		cmdline: text('cmdline'),
		containerId: text('container_id'),

		// type-specific: file_open
		filePath: text('file_path'),
		flags: text('flags'),

		// type-specific: net_connect / listen
		destIp: text('dest_ip'),
		destPort: integer('dest_port'),
		proto: text('proto'),

		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('events_host_ts_idx').on(t.hostId, t.ts),
		index('events_type_idx').on(t.type),
		index('events_pid_idx').on(t.hostId, t.pid)
	]
);

export const rules = pgTable('rules', {
	id: text('id').primaryKey(),
	accountId: text('account_id')
		.notNull()
		.references(() => accounts.id),
	name: text('name').notNull(),
	description: text('description'),
	enabled: boolean('enabled').notNull().default(true),
	severity: text('severity').notNull().default('medium'),
	// Declarative condition (JSON) evaluated by the rule engine (SPEC §8.5).
	condition: jsonb('condition').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const alerts = pgTable(
	'alerts',
	{
		id: text('id').primaryKey(),
		hostId: text('host_id')
			.notNull()
			.references(() => hosts.id),
		ruleId: text('rule_id')
			.notNull()
			.references(() => rules.id),
		eventId: text('event_id')
			.notNull()
			.references(() => events.id),
		ts: text('ts').notNull(),
		severity: text('severity').notNull(),
		message: text('message').notNull(),
		// open → acknowledged → resolved
		status: text('status').notNull().default('open'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('alerts_host_status_idx').on(t.hostId, t.status)]
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type HostRow = typeof hosts.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
