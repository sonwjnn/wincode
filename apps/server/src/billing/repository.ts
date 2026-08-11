import type { AgentBillingKind } from "@wincode/ai";
import {
	billingNormalizedUsageSchema,
	billingPricebook,
} from "@wincode/billing/pricing";
import {
	billingRequestReservation,
	billingSubscription,
	billingUsageEvent,
} from "@wincode/db/schema";
import { and, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type {
	BillingNormalizedUsage,
	BillingRepositoryOk,
	BillingRepositoryUnavailable,
	BillingRequestReservationRow,
	BillingReservationAccepted,
	BillingReservationDenied,
	BillingReservationDeniedReason,
	BillingReservationState,
	BillingUsageEventRow,
} from "./types";

export type BillingRepositoryConfig = {
	mode: "disabled" | "allowlist-shadow" | "canary-enforce" | "enforce";
	alphaUserAllowlist: ReadonlySet<string>;
	providerKillSwitches: ReadonlySet<string>;
	modelKillSwitches: ReadonlySet<string>;
	dailyGlobalCostCapUsdMicros: bigint;
	fundedRequestInputTokenLimit: bigint;
	fundedRequestOutputTokenLimit: bigint;
	fundedRequestStepLimit: bigint;
	fundedRequestTimeWindowSeconds: bigint;
	priceBookVersion: string;
	priceBookEffectiveAt: Date;
	goProductId?: string;
	goRollingQuotaUsdMicros?: bigint;
};

export type BillingRequestReservationInput = {
	requestId: string;
	userId: string;
	runtimeProvider: string;
	runtimeModel: string;
	mode: AgentBillingKind;
	startedAt: Date;
};

export type BillingSettlementInput = {
	requestId: string;
	stepIndex: number;
	settledUsage: BillingNormalizedUsage;
	runtimeProvider: string;
	runtimeModel: string;
};

export type BillingFinalizeInput = {
	requestId: string;
	expectedStepCount: number;
	finalAggregate: BillingNormalizedUsage;
	reconciliationRequired: boolean;
};

const schema = { billingRequestReservation, billingUsageEvent };
export type BillingRepositoryDb = Pick<
	NeonDatabase<typeof schema>,
	"transaction"
>;
type BillingTx = Parameters<
	Parameters<BillingRepositoryDb["transaction"]>[0]
>[0];

export type BillingRepository = {
	getUsage: (
		userId: string,
		at?: Date
	) => Promise<
		| BillingRepositoryOk<{
				entitled: boolean;
				usedUsdMicros: bigint;
				quotaUsdMicros: bigint | null;
				windowStartedAt: Date;
		  }>
		| BillingRepositoryUnavailable
	>;
	reserveRequest: (
		input: BillingRequestReservationInput
	) => Promise<
		| BillingReservationAccepted
		| BillingReservationDenied
		| BillingRepositoryUnavailable
	>;
	settleStep: (
		input: BillingSettlementInput
	) => Promise<
		| BillingRepositoryOk<{ accruedUsdMicros: bigint }>
		| BillingRepositoryUnavailable
	>;
	finalizeRequest: (
		input: BillingFinalizeInput
	) => Promise<
		| BillingRepositoryOk<{ reconciliationRequired: boolean }>
		| BillingRepositoryUnavailable
	>;
	expireStaleActiveRequests: (
		now?: Date
	) => Promise<
		BillingRepositoryOk<{ expiredCount: number }> | BillingRepositoryUnavailable
	>;
};

const denied = (
	reason: BillingReservationDeniedReason
): BillingReservationDenied => ({ ok: false, kind: "denied", reason });
const unavailable = (reason: string): BillingRepositoryUnavailable => ({
	ok: false,
	kind: "unavailable",
	reason,
});
const microTokens = 1_000_000n;
const globalLockKey = 9_100_001;
const userLockKey = 9_100_002;
const supportedPairs = new Set([
	"openai:gpt-5.4-mini",
	"google:gemini-2.5-flash",
]);
const pricebookEffectiveAt = new Date(
	`${billingPricebook.effectiveDate}T00:00:00.000Z`
);

const ceilMicros = (tokens: bigint, microsPerMillion: bigint): bigint =>
	(tokens * microsPerMillion + microTokens - 1n) / microTokens;
const runtimeKey = (provider: string, model: string): string =>
	`${provider}:${model}`;
const toBigint = (value: unknown): bigint => {
	if (typeof value !== "bigint") {
		throw new Error("billing db bigint expected");
	}
	return value;
};
const requestExpiry = (startedAt: Date, seconds: bigint): Date =>
	new Date(startedAt.getTime() + Number(seconds) * 1000);
const row0 = <T extends Record<string, unknown>>(
	rows: readonly T[]
): T | null => rows[0] ?? null;
const sumBigint = (values: readonly bigint[]): bigint =>
	values.reduce((sum, value) => sum + value, 0n);

const stateOk = (status: string): status is BillingReservationState =>
	[
		"active",
		"expired",
		"completed",
		"reconciliation-required",
		"aborted",
	].includes(status);

const lockKeys = async (tx: BillingTx, userId: string): Promise<void> => {
	await tx.execute(sql`select pg_advisory_xact_lock(${globalLockKey})`);
	await tx.execute(
		sql`select pg_advisory_xact_lock(${userLockKey}, hashtext(${userId}))`
	);
};

const dayBounds = (startedAt: Date) => {
	const start = new Date(
		Date.UTC(
			startedAt.getUTCFullYear(),
			startedAt.getUTCMonth(),
			startedAt.getUTCDate()
		)
	);
	return { dayStart: start, dayEnd: new Date(start.getTime() + 86_400_000) };
};

const hasActiveGoEntitlement = async (
	tx: BillingTx,
	userId: string,
	productId: string,
	at: Date
): Promise<boolean> => {
	const rows = await tx
		.select()
		.from(billingSubscription)
		.where(
			and(
				eq(billingSubscription.userId, userId),
				eq(billingSubscription.providerProductId, productId),
				eq(billingSubscription.status, "active"),
				or(
					sql`${billingSubscription.currentPeriodStartAt} is null`,
					lte(billingSubscription.currentPeriodStartAt, at)
				),
				or(
					sql`${billingSubscription.currentPeriodEndAt} is null`,
					gt(billingSubscription.currentPeriodEndAt, at)
				)
			)
		);
	return rows.length > 0;
};

const rollingUserExposure = async (
	tx: BillingTx,
	userId: string,
	at: Date
): Promise<bigint> => {
	const events = (await tx
		.select()
		.from(billingUsageEvent)
		.where(
			and(
				eq(billingUsageEvent.userId, userId),
				gte(
					billingUsageEvent.recordedAt,
					new Date(at.getTime() - 30 * 86_400_000)
				),
				lt(billingUsageEvent.recordedAt, at)
			)
		)) as readonly BillingUsageEventRow[];
	const unresolved = (await tx
		.select()
		.from(billingRequestReservation)
		.where(
			and(
				eq(billingRequestReservation.userId, userId),
				or(
					eq(billingRequestReservation.status, "active"),
					eq(billingRequestReservation.status, "expired"),
					eq(billingRequestReservation.status, "reconciliation-required")
				)
			)
		)) as readonly BillingRequestReservationRow[];
	const unresolvedRequestIds = new Set(unresolved.map((row) => row.requestId));
	return sumBigint([
		...events
			.filter((event) => !unresolvedRequestIds.has(event.requestId))
			.map((event) => toBigint(event.usdMicros)),
		...unresolved.map(stateExposureMicros),
	]);
};

const stateExposureMicros = (row: BillingRequestReservationRow): bigint => {
	const reserved = toBigint(row.reservedUsdMicros);
	const accrued = toBigint(row.accruedUsdMicros);
	if (
		row.status === "active" ||
		row.status === "expired" ||
		row.status === "reconciliation-required"
	) {
		return reserved > accrued ? reserved : accrued;
	}
	return accrued;
};
const usageMatches = (
	row: BillingUsageEventRow,
	settledUsage: BillingNormalizedUsage
): boolean =>
	toBigint(row.uncachedInputTokens) === settledUsage.uncachedInput &&
	toBigint(row.cacheReadTokens ?? 0n) === settledUsage.cacheRead &&
	toBigint(row.cacheWriteTokens ?? 0n) === settledUsage.cacheWrite &&
	toBigint(row.outputTokens) === settledUsage.output &&
	toBigint(row.reasoningTokens ?? 0n) === settledUsage.reasoning &&
	toBigint(row.totalTokens) === settledUsage.total;

const parseCanonicalAggregate = (
	input: BillingNormalizedUsage
): BillingNormalizedUsage | null => {
	const parsed = billingNormalizedUsageSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
};

const assertConfig = (config: BillingRepositoryConfig): void => {
	if (config.priceBookVersion !== billingPricebook.version) {
		throw new Error("billing config price version mismatch");
	}
	if (
		config.priceBookEffectiveAt.getTime() !== pricebookEffectiveAt.getTime()
	) {
		throw new Error("billing config price effective date mismatch");
	}
};

const preflightReserve = (
	config: BillingRepositoryConfig,
	input: BillingRequestReservationInput
): BillingReservationDenied | null => {
	if (config.mode === "disabled") {
		return denied("misconfigured");
	}
	if (
		(config.mode === "allowlist-shadow" || config.mode === "canary-enforce") &&
		!config.alphaUserAllowlist.has(input.userId)
	) {
		return denied("not-allowlisted");
	}
	if (
		config.providerKillSwitches.has(input.runtimeProvider) ||
		config.modelKillSwitches.has(input.runtimeModel)
	) {
		return denied("kill-switch");
	}
	if (
		!supportedPairs.has(runtimeKey(input.runtimeProvider, input.runtimeModel))
	) {
		return denied("invalid-request");
	}
	return null;
};

const preflightSettle = (
	input: BillingSettlementInput
): BillingRepositoryUnavailable | null =>
	supportedPairs.has(runtimeKey(input.runtimeProvider, input.runtimeModel))
		? null
		: unavailable("unsupported-runtime");

const reservationRuntimeMatches = (
	reservation: BillingRequestReservationRow,
	runtimeProvider: string,
	runtimeModel: string
): boolean =>
	runtimeKey(runtimeProvider, runtimeModel) ===
	runtimeKey(
		String(reservation.runtimeProvider),
		String(reservation.runtimeModel)
	);

const settledUsageMatchesReservation = (
	reservation: BillingRequestReservationRow,
	settledUsage: BillingNormalizedUsage
): boolean =>
	settledUsage.provider === String(reservation.runtimeProvider) &&
	settledUsage.modelId === String(reservation.runtimeModel);

const illegalSettlementStatus = (status: BillingReservationState): boolean =>
	status === "expired" ||
	status === "completed" ||
	status === "reconciliation-required" ||
	status === "aborted";

const reserveHoldMicros = (
	config: BillingRepositoryConfig,
	pair: (typeof billingPricebook.models)[keyof typeof billingPricebook.models]
): bigint =>
	config.fundedRequestStepLimit *
	sumBigint([
		ceilMicros(
			config.fundedRequestInputTokenLimit,
			pair.inputMicrosPerMillionTokens
		),
		ceilMicros(
			config.fundedRequestInputTokenLimit,
			pair.cacheReadMicrosPerMillionTokens
		),
		ceilMicros(
			config.fundedRequestOutputTokenLimit,
			pair.outputMicrosPerMillionTokens
		),
	]);

const lockReservation = async (
	tx: BillingTx,
	requestId: string
): Promise<BillingRequestReservationRow | null> => {
	const reservation = row0(
		(await tx
			.select()
			.from(billingRequestReservation)
			.where(
				eq(billingRequestReservation.requestId, requestId)
			)) as readonly BillingRequestReservationRow[]
	);
	if (!reservation) {
		return null;
	}
	await lockKeys(tx, String(reservation.userId));
	return row0(
		(await tx
			.select()
			.from(billingRequestReservation)
			.where(
				eq(billingRequestReservation.requestId, requestId)
			)) as readonly BillingRequestReservationRow[]
	);
};

const activeReservationsForUser = async (tx: BillingTx, userId: string) =>
	(await tx
		.select()
		.from(billingRequestReservation)
		.where(
			and(eq(billingRequestReservation.userId, userId), userLockFilter())
		)) as readonly BillingRequestReservationRow[];

const userLockFilter = () =>
	or(
		eq(billingRequestReservation.status, "active"),
		eq(billingRequestReservation.status, "reconciliation-required")
	);
const unresolvedExposureFilter = () =>
	or(
		eq(billingRequestReservation.status, "active"),
		eq(billingRequestReservation.status, "expired"),
		eq(billingRequestReservation.status, "reconciliation-required")
	);
const dailyExposure = async (tx: BillingTx, startedAt: Date) => {
	const { dayStart, dayEnd } = dayBounds(startedAt);
	const unresolved = unresolvedExposureFilter();
	return sumBigint(
		(
			(await tx
				.select()
				.from(billingRequestReservation)
				.where(
					and(
						lt(billingRequestReservation.startedAt, dayEnd),
						or(gte(billingRequestReservation.startedAt, dayStart), unresolved)
					)
				)) as readonly BillingRequestReservationRow[]
		).map(stateExposureMicros)
	);
};
const expireActive = async (tx: BillingTx, now: Date): Promise<number> => {
	await lockKeys(tx, "global-expiry");
	const rows = (await tx
		.select()
		.from(billingRequestReservation)
		.where(
			expiredReservationFilter(now)
		)) as readonly BillingRequestReservationRow[];
	await tx
		.update(billingRequestReservation)
		.set({
			reconciliationRequiredAt: now,
			status: "expired",
			updatedAt: now,
		})
		.where(expiredReservationFilter(now));
	return rows.length;
};

const accruedMicros = (
	reservation: BillingRequestReservationRow,
	settledUsage: BillingNormalizedUsage
): bigint =>
	sumBigint([
		ceilMicros(
			settledUsage.uncachedInput,
			toBigint(reservation.rateInputUsdMicrosPerMillionTokens)
		),
		ceilMicros(
			settledUsage.cacheRead,
			toBigint(reservation.rateCacheReadUsdMicrosPerMillionTokens)
		),
		ceilMicros(
			settledUsage.cacheWrite,
			toBigint(reservation.rateCacheWriteUsdMicrosPerMillionTokens)
		),
		ceilMicros(
			settledUsage.output,
			toBigint(reservation.rateOutputUsdMicrosPerMillionTokens)
		),
		ceilMicros(
			settledUsage.reasoning,
			toBigint(reservation.rateReasoningUsdMicrosPerMillionTokens)
		),
	]);

const expiredReservationFilter = (now: Date) =>
	and(
		eq(billingRequestReservation.status, "active"),
		lt(billingRequestReservation.expiresAt, now)
	);

const shouldReconcileFinalization = (
	input: BillingFinalizeInput,
	reservation: BillingRequestReservationRow,
	events: readonly BillingUsageEventRow[]
): boolean => {
	if (
		input.reconciliationRequired ||
		reservation.reconciliationRequiredAt !== null
	) {
		return true;
	}
	if (events.length !== input.expectedStepCount) {
		return true;
	}
	if (
		runtimeKey(reservation.runtimeProvider, reservation.runtimeModel) !==
		runtimeKey(input.finalAggregate.provider, input.finalAggregate.modelId)
	) {
		return true;
	}
	if (input.finalAggregate.modality !== "text") {
		return true;
	}
	return !matchesFinalAggregate(events, input.finalAggregate);
};

const buildReservationInsert = (
	input: BillingRequestReservationInput,
	pair: (typeof billingPricebook.models)[keyof typeof billingPricebook.models],
	hold: bigint,
	expiresAt: Date
): typeof billingRequestReservation.$inferInsert => ({
	requestId: input.requestId,
	userId: input.userId,
	runtimeProvider: input.runtimeProvider,
	runtimeModel: input.runtimeModel,
	mode: input.mode,
	status: "active",
	reservedUsdMicros: hold,
	accruedUsdMicros: 0n,
	priceVersion: billingPricebook.version,
	priceEffectiveAt: pricebookEffectiveAt,
	rateInputUsdMicrosPerMillionTokens: pair.inputMicrosPerMillionTokens,
	rateCacheReadUsdMicrosPerMillionTokens: pair.cacheReadMicrosPerMillionTokens,
	rateCacheWriteUsdMicrosPerMillionTokens: 0n,
	rateOutputUsdMicrosPerMillionTokens: pair.outputMicrosPerMillionTokens,
	rateReasoningUsdMicrosPerMillionTokens: 0n,
	startedAt: input.startedAt,
	expiresAt,
	updatedAt: input.startedAt,
});

const reconcileReservation = async (
	tx: BillingTx,
	requestId: string
): Promise<void> => {
	await tx
		.update(billingRequestReservation)
		.set({
			status: "reconciliation-required",
			reconciliationRequiredAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(billingRequestReservation.requestId, requestId));
};

const completeReservation = async (
	tx: BillingTx,
	requestId: string
): Promise<void> => {
	await tx
		.update(billingRequestReservation)
		.set({
			status: "completed",
			finalizedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(billingRequestReservation.requestId, requestId));
};

const settleStepCore = async (
	tx: BillingTx,
	input: BillingSettlementInput
): Promise<
	| BillingRepositoryOk<{ accruedUsdMicros: bigint }>
	| BillingRepositoryUnavailable
> => {
	const reservation = await lockReservation(tx, input.requestId);
	if (!reservation) {
		return unavailable("missing-reservation");
	}
	if (
		!stateOk(reservation.status) ||
		illegalSettlementStatus(reservation.status)
	) {
		return unavailable("illegal-transition");
	}
	const events = (await tx
		.select()
		.from(billingUsageEvent)
		.where(
			eq(billingUsageEvent.requestId, input.requestId)
		)) as readonly BillingUsageEventRow[];
	const existing =
		events.find((event) => Number(event.stepIndex) === input.stepIndex) ?? null;
	if (
		!reservationRuntimeMatches(
			reservation,
			input.runtimeProvider,
			input.runtimeModel
		)
	) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, accruedUsdMicros: 0n };
	}
	const parsed = billingNormalizedUsageSchema.safeParse(input.settledUsage);
	if (!parsed.success) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, accruedUsdMicros: 0n };
	}
	if (!settledUsageMatchesReservation(reservation, parsed.data)) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, accruedUsdMicros: 0n };
	}
	if (existing) {
		if (!usageMatches(existing, parsed.data)) {
			await reconcileReservation(tx, input.requestId);
		}
		return { ok: true, accruedUsdMicros: 0n };
	}
	const accrued = accruedMicros(reservation, parsed.data);
	if (
		toBigint(reservation.accruedUsdMicros) + accrued >
		toBigint(reservation.reservedUsdMicros)
	) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, accruedUsdMicros: 0n };
	}
	const inserted = await tx
		.insert(billingUsageEvent)
		.values({
			id: crypto.randomUUID(),
			userId: String(reservation.userId),
			requestId: input.requestId,
			stepIndex: input.stepIndex,
			provider: input.runtimeProvider,
			model: input.runtimeModel,
			uncachedInputTokens: parsed.data.uncachedInput,
			cacheReadTokens: parsed.data.cacheRead,
			cacheWriteTokens: parsed.data.cacheWrite,
			outputTokens: parsed.data.output,
			reasoningTokens: parsed.data.reasoning,
			totalTokens: parsed.data.total,
			usdMicros: accrued,
			priceVersion: String(reservation.priceVersion),
			priceEffectiveAt: reservation.priceEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: toBigint(
				reservation.rateInputUsdMicrosPerMillionTokens
			),
			rateCacheReadUsdMicrosPerMillionTokens: toBigint(
				reservation.rateCacheReadUsdMicrosPerMillionTokens
			),
			rateCacheWriteUsdMicrosPerMillionTokens: toBigint(
				reservation.rateCacheWriteUsdMicrosPerMillionTokens
			),
			rateOutputUsdMicrosPerMillionTokens: toBigint(
				reservation.rateOutputUsdMicrosPerMillionTokens
			),
			rateReasoningUsdMicrosPerMillionTokens: toBigint(
				reservation.rateReasoningUsdMicrosPerMillionTokens
			),
		})
		.returning({ id: billingUsageEvent.id });
	if (inserted.length === 0) {
		return { ok: true, accruedUsdMicros: 0n };
	}
	await tx
		.update(billingRequestReservation)
		.set({
			accruedUsdMicros: sql`${billingRequestReservation.accruedUsdMicros} + ${accrued}`,
			updatedAt: new Date(),
		})
		.where(eq(billingRequestReservation.requestId, input.requestId));
	return { ok: true, accruedUsdMicros: accrued };
};

const finalizeCore = async (
	tx: BillingTx,
	input: BillingFinalizeInput
): Promise<
	| BillingRepositoryOk<{ reconciliationRequired: boolean }>
	| BillingRepositoryUnavailable
> => {
	const reservation = await lockReservation(tx, input.requestId);
	if (!reservation) {
		return unavailable("missing-reservation");
	}
	if (
		reservation.status === "expired" ||
		reservation.status === "completed" ||
		reservation.status === "reconciliation-required" ||
		reservation.status === "aborted"
	) {
		return unavailable("illegal-transition");
	}
	const events = (await tx
		.select()
		.from(billingUsageEvent)
		.where(
			eq(billingUsageEvent.requestId, input.requestId)
		)) as readonly BillingUsageEventRow[];
	const sum = sumBigint(events.map((event) => toBigint(event.usdMicros)));
	const finalAggregate = parseCanonicalAggregate(input.finalAggregate);
	if (!finalAggregate) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, reconciliationRequired: true };
	}
	if (
		sum !== toBigint(reservation.accruedUsdMicros) ||
		shouldReconcileFinalization(
			{ ...input, finalAggregate },
			reservation,
			events
		)
	) {
		await reconcileReservation(tx, input.requestId);
		return { ok: true, reconciliationRequired: true };
	}
	await completeReservation(tx, input.requestId);
	return { ok: true, reconciliationRequired: false };
};

const matchesFinalAggregate = (
	events: readonly BillingUsageEventRow[],
	finalAggregate: BillingNormalizedUsage
): boolean => {
	let input = 0n;
	let output = 0n;
	let total = 0n;
	let cacheRead = 0n;
	let cacheWrite = 0n;
	let reasoning = 0n;
	for (const event of events) {
		input +=
			toBigint(event.uncachedInputTokens) + toBigint(event.cacheReadTokens);
		output += toBigint(event.outputTokens);
		total += toBigint(event.totalTokens);
		cacheRead += toBigint(event.cacheReadTokens);
		cacheWrite += toBigint(event.cacheWriteTokens);
		reasoning += toBigint(event.reasoningTokens);
	}
	return (
		toBigint(finalAggregate.input) === input &&
		toBigint(finalAggregate.uncachedInput) === input - cacheRead &&
		toBigint(finalAggregate.cacheRead) === cacheRead &&
		toBigint(finalAggregate.cacheWrite) === cacheWrite &&
		toBigint(finalAggregate.output) === output &&
		toBigint(finalAggregate.reasoning) === reasoning &&
		toBigint(finalAggregate.total) === total
	);
};

type BillingPrice =
	(typeof billingPricebook.models)[keyof typeof billingPricebook.models];

const reserveRequestTransaction = async (
	tx: BillingTx,
	config: BillingRepositoryConfig,
	input: BillingRequestReservationInput,
	pair: BillingPrice
) => {
	const hold = reserveHoldMicros(config, pair);
	await expireActive(tx, input.startedAt);
	const requiresEntitlement =
		config.mode === "canary-enforce" || config.mode === "enforce";
	if (requiresEntitlement) {
		const goProductId = config.goProductId;
		const goRollingQuotaUsdMicros = config.goRollingQuotaUsdMicros;
		if (!(goProductId && goRollingQuotaUsdMicros !== undefined)) {
			return denied("misconfigured");
		}
		if (
			!(await hasActiveGoEntitlement(
				tx,
				input.userId,
				goProductId,
				input.startedAt
			))
		) {
			return denied("not-entitled");
		}
		if (
			(await rollingUserExposure(tx, input.userId, input.startedAt)) + hold >
			goRollingQuotaUsdMicros
		) {
			return denied("rolling-quota");
		}
	}
	if ((await activeReservationsForUser(tx, input.userId)).length > 0) {
		return denied("duplicate-active-user");
	}
	const unresolvedExposure = await dailyExposure(tx, input.startedAt);
	if (unresolvedExposure + hold > config.dailyGlobalCostCapUsdMicros) {
		return denied("daily-cap");
	}
	const expiresAt = requestExpiry(
		input.startedAt,
		config.fundedRequestTimeWindowSeconds
	);
	const inserted = await tx
		.insert(billingRequestReservation)
		.values(buildReservationInsert(input, pair, hold, expiresAt))
		.returning({ id: billingRequestReservation.requestId });
	if (inserted.length === 0) {
		return unavailable("db");
	}
	return {
		ok: true as const,
		requestId: input.requestId,
		reservedUsdMicros: hold,
		expiresAt,
		priceVersion: billingPricebook.version,
		priceEffectiveAt: pricebookEffectiveAt,
	};
};

export const createBillingRepository = (
	db: BillingRepositoryDb,
	config: BillingRepositoryConfig
): BillingRepository => {
	assertConfig(config);
	return {
		async getUsage(userId, at = new Date()) {
			try {
				return await db.transaction(async (tx) => {
					const windowStartedAt = new Date(at.getTime() - 30 * 86_400_000);
					let entitled = false;
					if (config.mode === "allowlist-shadow") {
						entitled = config.alphaUserAllowlist.has(userId);
					} else if (config.goProductId) {
						entitled = await hasActiveGoEntitlement(
							tx,
							userId,
							config.goProductId,
							at
						);
						if (config.mode === "canary-enforce") {
							entitled = entitled && config.alphaUserAllowlist.has(userId);
						}
					}
					const exposure = await rollingUserExposure(tx, userId, at);
					return {
						ok: true as const,
						entitled,
						usedUsdMicros: exposure,
						quotaUsdMicros: config.goRollingQuotaUsdMicros ?? null,
						windowStartedAt,
					};
				});
			} catch {
				return unavailable("db");
			}
		},
		async reserveRequest(input) {
			const preflight = preflightReserve(config, input);
			if (preflight) {
				return preflight;
			}
			try {
				if (
					!supportedPairs.has(
						runtimeKey(input.runtimeProvider, input.runtimeModel)
					)
				) {
					return denied("invalid-request");
				}
				const pair =
					billingPricebook.models[
						input.runtimeModel as keyof typeof billingPricebook.models
					];
				return await db.transaction((tx) =>
					reserveRequestTransaction(tx, config, input, pair)
				);
			} catch {
				return unavailable("db");
			}
		},
		async settleStep(input) {
			const preflight = preflightSettle(input);
			if (preflight) {
				return preflight;
			}
			try {
				if (input.stepIndex + 1 > Number(config.fundedRequestStepLimit)) {
					return unavailable("step-cap");
				}
				return await db.transaction(async (tx) => settleStepCore(tx, input));
			} catch {
				return unavailable("db");
			}
		},
		async finalizeRequest(input) {
			try {
				return await db.transaction(async (tx) => finalizeCore(tx, input));
			} catch {
				return unavailable("db");
			}
		},
		async expireStaleActiveRequests(now = new Date()) {
			try {
				return await db.transaction(async (tx) => ({
					ok: true,
					expiredCount: await expireActive(tx, now),
				}));
			} catch {
				return unavailable("db");
			}
		},
	};
};
