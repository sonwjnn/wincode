import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const billingWebhookInbox = pgTable(
	"billingWebhookInbox",
	{
		id: text("id").primaryKey(),
		providerWebhookId: text("providerWebhookId").notNull(),
		eventType: text("eventType").notNull(),
		provider: text("provider").notNull(),
		eventSource: text("eventSource").notNull(),
		eventAt: timestamp("eventAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		outcome: text("outcome").notNull(),
		processedAt: timestamp("processedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		receivedAt: timestamp("receivedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("billingWebhookInbox_provider_providerWebhookId_unique").on(
			table.provider,
			table.providerWebhookId
		),
	]
);

export const billingSubscription = pgTable(
	"billingSubscription",
	{
		id: text("id").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		provider: text("provider").notNull(),
		providerSubscriptionId: text("providerSubscriptionId").notNull(),
		providerCustomerId: text("providerCustomerId").notNull(),
		providerProductId: text("providerProductId").notNull(),
		eventSource: text("eventSource").notNull(),
		eventAt: timestamp("eventAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		cancelAt: timestamp("cancelAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		endAt: timestamp("endAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		status: text("status").notNull(),
		currentPeriodStartAt: timestamp("currentPeriodStartAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		currentPeriodEndAt: timestamp("currentPeriodEndAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		canceledAt: timestamp("canceledAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		createdAt: timestamp("createdAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex(
			"billingSubscription_provider_providerSubscriptionId_unique"
		).on(table.provider, table.providerSubscriptionId),
		check(
			"billingSubscription_status_allowed",
			sql`${table.status} in ('active', 'trialing', 'canceled', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid')`
		),
		index("billingSubscription_userId_index").on(table.userId),
	]
);

export const billingRequestReservation = pgTable(
	"billingRequestReservation",
	{
		requestId: text("requestId").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		runtimeProvider: text("runtimeProvider").notNull(),
		runtimeModel: text("runtimeModel").notNull(),
		mode: text("mode").notNull(),
		status: text("status").notNull(),
		reservedUsdMicros: bigint("reservedUsdMicros", {
			mode: "bigint",
		}).notNull(),
		accruedUsdMicros: bigint("accruedUsdMicros", { mode: "bigint" }).notNull(),
		priceVersion: text("priceVersion").notNull(),
		priceEffectiveAt: timestamp("priceEffectiveAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		rateInputUsdMicrosPerMillionTokens: bigint(
			"rateInputUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateCacheReadUsdMicrosPerMillionTokens: bigint(
			"rateCacheReadUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateCacheWriteUsdMicrosPerMillionTokens: bigint(
			"rateCacheWriteUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateOutputUsdMicrosPerMillionTokens: bigint(
			"rateOutputUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateReasoningUsdMicrosPerMillionTokens: bigint(
			"rateReasoningUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		startedAt: timestamp("startedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		expiresAt: timestamp("expiresAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		finalizedAt: timestamp("finalizedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		reconciliationRequiredAt: timestamp("reconciliationRequiredAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		reconciliationCompletedAt: timestamp("reconciliationCompletedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}),
		createdAt: timestamp("createdAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("billingRequestReservation_userId_active_unique")
			.on(table.userId)
			.where(sql`${table.status} = 'active'`),
		uniqueIndex("billingRequestReservation_requestId_userId_unique").on(
			table.requestId,
			table.userId
		),
		check(
			"billingRequestReservation_status_allowed",
			sql`${table.status} in ('active', 'completed', 'aborted', 'expired', 'reconciliation-required')`
		),
		index("billingRequestReservation_userId_index").on(table.userId),
		index("billingRequestReservation_status_index").on(table.status),
		index("billingRequestReservation_startedAt_index").on(table.startedAt),
		index("billingRequestReservation_expiresAt_index").on(table.expiresAt),
		check(
			"billingRequestReservation_reservedUsdMicros_nonnegative",
			sql`${table.reservedUsdMicros} >= 0`
		),
		check(
			"billingRequestReservation_accruedUsdMicros_nonnegative",
			sql`${table.accruedUsdMicros} >= 0`
		),
		check(
			"billingRequestReservation_rateInputUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateInputUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingRequestReservation_rateCacheReadUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateCacheReadUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingRequestReservation_rateCacheWriteUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateCacheWriteUsdMicrosPerMillionTokens} = 0`
		),
		check(
			"billingRequestReservation_rateOutputUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateOutputUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingRequestReservation_rateReasoningUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateReasoningUsdMicrosPerMillionTokens} = 0`
		),
	]
);

export const billingUsageEvent = pgTable(
	"billingUsageEvent",
	{
		id: text("id").primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "restrict" }),
		requestId: text("requestId")
			.notNull()
			.references(() => billingRequestReservation.requestId, {
				onDelete: "restrict",
			}),
		stepIndex: bigint("stepIndex", { mode: "number" }).notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		uncachedInputTokens: bigint("uncachedInputTokens", {
			mode: "bigint",
		}).notNull(),
		cacheReadTokens: bigint("cacheReadTokens", { mode: "bigint" }),
		cacheWriteTokens: bigint("cacheWriteTokens", { mode: "bigint" }),
		outputTokens: bigint("outputTokens", { mode: "bigint" }).notNull(),
		reasoningTokens: bigint("reasoningTokens", { mode: "bigint" }),
		totalTokens: bigint("totalTokens", { mode: "bigint" }).notNull(),
		usdMicros: bigint("usdMicros", { mode: "bigint" }).notNull(),
		priceVersion: text("priceVersion").notNull(),
		priceEffectiveAt: timestamp("priceEffectiveAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		}).notNull(),
		rateInputUsdMicrosPerMillionTokens: bigint(
			"rateInputUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateCacheReadUsdMicrosPerMillionTokens: bigint(
			"rateCacheReadUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateCacheWriteUsdMicrosPerMillionTokens: bigint(
			"rateCacheWriteUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateOutputUsdMicrosPerMillionTokens: bigint(
			"rateOutputUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		rateReasoningUsdMicrosPerMillionTokens: bigint(
			"rateReasoningUsdMicrosPerMillionTokens",
			{
				mode: "bigint",
			}
		).notNull(),
		recordedAt: timestamp("recordedAt", {
			mode: "date",
			precision: 3,
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("billingUsageEvent_requestId_stepIndex_unique").on(
			table.requestId,
			table.stepIndex
		),
		check(
			"billingUsageEvent_stepIndex_nonnegative",
			sql`${table.stepIndex} >= 0`
		),
		index("billingUsageEvent_userId_index").on(table.userId),
		index("billingUsageEvent_requestId_index").on(table.requestId),
		index("billingUsageEvent_recordedAt_index").on(table.recordedAt),
		check(
			"billingUsageEvent_uncachedInputTokens_nonnegative",
			sql`${table.uncachedInputTokens} >= 0`
		),
		check(
			"billingUsageEvent_cacheReadTokens_nonnegative",
			sql`${table.cacheReadTokens} is null or ${table.cacheReadTokens} >= 0`
		),
		check(
			"billingUsageEvent_cacheWriteTokens_nonnegative",
			sql`${table.cacheWriteTokens} is null or ${table.cacheWriteTokens} = 0`
		),
		check(
			"billingUsageEvent_cacheWriteRateUsdMicrosPerMillionTokens_zero",
			sql`${table.rateCacheWriteUsdMicrosPerMillionTokens} = 0`
		),
		check(
			"billingUsageEvent_rateInputUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateInputUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingUsageEvent_rateCacheReadUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateCacheReadUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingUsageEvent_rateCacheWriteUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateCacheWriteUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingUsageEvent_rateOutputUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateOutputUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingUsageEvent_rateReasoningUsdMicrosPerMillionTokens_nonnegative",
			sql`${table.rateReasoningUsdMicrosPerMillionTokens} >= 0`
		),
		check(
			"billingUsageEvent_reasoningRateUsdMicrosPerMillionTokens_zero",
			sql`${table.rateReasoningUsdMicrosPerMillionTokens} = 0`
		),
		check(
			"billingUsageEvent_outputTokens_nonnegative",
			sql`${table.outputTokens} >= 0`
		),
		check(
			"billingUsageEvent_reasoningTokens_nonnegative",
			sql`${table.reasoningTokens} is null or ${table.reasoningTokens} >= 0`
		),
		check(
			"billingUsageEvent_totalTokens_nonnegative",
			sql`${table.totalTokens} >= 0`
		),
		check(
			"billingUsageEvent_usdMicros_nonnegative",
			sql`${table.usdMicros} >= 0`
		),
		check(
			"billingUsageEvent_totalTokens_consistent",
			sql`${table.totalTokens} = ${table.uncachedInputTokens} + coalesce(${table.cacheReadTokens}, 0) + coalesce(${table.cacheWriteTokens}, 0) + ${table.outputTokens}`
		),
		check(
			"billingUsageEvent_reasoningTokens_lte_outputTokens",
			sql`${table.reasoningTokens} is null or ${table.reasoningTokens} <= ${table.outputTokens}`
		),
		foreignKey({
			columns: [table.requestId, table.userId],
			foreignColumns: [
				billingRequestReservation.requestId,
				billingRequestReservation.userId,
			],
			name: "billingUsageEvent_requestId_userId_reservation_fk",
		}),
	]
);
