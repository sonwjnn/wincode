import { describe, expect, it } from "bun:test";
import { billingPricebook } from "@wincode/billing/pricing";
import { billingRequestReservation } from "@wincode/db/schema";
import { createBillingRepository } from "./repository";

const config = {
	alphaUserAllowlist: new Set(["user-1"]),
	dailyGlobalCostCapUsdMicros: 100_000_000n,
	fundedRequestInputTokenLimit: 1_000_000n,
	fundedRequestOutputTokenLimit: 1_000_000n,
	fundedRequestStepLimit: 10n,
	fundedRequestTimeWindowSeconds: 900n,
	modelKillSwitches: new Set<string>(),
	mode: "allowlist-shadow" as const,
	priceBookEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
	priceBookVersion: "2026-07-19",
	providerKillSwitches: new Set<string>(),
};

type Row = Record<string, unknown>;
const baseUsage = {
	provider: "openai",
	modelId: "gpt-5.4-mini",
	input: 100n,
	uncachedInput: 100n,
	cacheRead: 0n,
	cacheWrite: 0n,
	output: 10n,
	reasoning: 0n,
	total: 110n,
	modality: "text",
} as const;

const createDb = () => {
	const reservations: Row[] = [];
	const events: Row[] = [];
	const tx = {
		execute: async () => undefined,
		select: () => ({
			from: (table: unknown) => ({
				where: async (query: unknown) => {
					if (table === billingRequestReservation) {
						if (String(query).includes("requestId")) {
							return reservations.filter((row) => row.requestId === "r1");
						}
						if (String(query).includes("status = 'active'")) {
							return reservations.filter((row) => row.status === "active");
						}
						return reservations;
					}
					return events;
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (values: Row) => ({
				where: async () => {
					if (table === billingRequestReservation) {
						for (const row of reservations) {
							Object.assign(row, values);
						}
					}
					return [];
				},
			}),
		}),
		insert: (table: unknown) => ({
			values: (row: Row) => ({
				returning: async () => {
					if (table === billingRequestReservation) {
						reservations.push({ ...row });
						return [{ id: row.requestId }];
					}
					events.push({ ...row });
					return [{ id: row.id }];
				},
			}),
		}),
	};
	return {
		db: { transaction: async <T>(fn: (tx: any) => Promise<T>) => fn(tx) },
		reservations,
		events,
	};
};

describe("billing repository", () => {
	it("reserve -> hold exact", async () => {
		const state = createDb();
		const repo = createBillingRepository(state.db, config);
		await expect(
			repo.reserveRequest({
				requestId: "r1",
				userId: "user-1",
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			})
		).resolves.toMatchObject({
			ok: true,
			reservedUsdMicros: 53_250_000n,
			priceVersion: billingPricebook.version,
		});
	});

	it("reserve rejects strict provider/model mismatch", async () => {
		const state = createDb();
		const repo = createBillingRepository(state.db, config);
		await expect(
			repo.reserveRequest({
				requestId: "r2",
				userId: "user-1",
				runtimeProvider: "openai",
				runtimeModel: "gemini-2.5-flash",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			})
		).resolves.toMatchObject({
			ok: false,
			kind: "denied",
			reason: "invalid-request",
		});
	});

	it("reserve upper-bounds gemini 999999+1 split settlement", async () => {
		const state = createDb();
		const repo = createBillingRepository(state.db, {
			...config,
			fundedRequestInputTokenLimit: 999_999n,
		});
		await expect(
			repo.reserveRequest({
				requestId: "r2b",
				userId: "user-1",
				runtimeProvider: "google",
				runtimeModel: "gemini-2.5-flash",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			})
		).resolves.toMatchObject({ ok: true, reservedUsdMicros: 28_300_000n });
	});

	it("duplicate step -> idempotent; mismatch -> reconciliation", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 1,
				settledUsage: baseUsage,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({ ok: true, accruedUsdMicros: 120n });
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 1,
				settledUsage: baseUsage,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({ ok: true, accruedUsdMicros: 0n });
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 2,
				settledUsage: { ...baseUsage, total: 111n },
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({ ok: true, accruedUsdMicros: 0n });
	});

	it("active ownership persists through reconciliation until terminal", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 250n,
			reconciliationRequiredAt: new Date("2026-07-20T03:05:00.000Z"),
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		const reservation = state.reservations[0];
		if (!reservation) {
			throw new Error("missing reservation");
		}
		await expect(
			repo.reserveRequest({
				requestId: "r2",
				userId: "user-1",
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:06:00.000Z"),
			})
		).resolves.toMatchObject({
			ok: false,
			kind: "denied",
			reason: "duplicate-active-user",
		});
	});

	it("settle reconciles when parsed usage runtime pair differs", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 1,
				settledUsage: {
					...baseUsage,
					provider: "google",
					modelId: "gemini-2.5-flash",
				},
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({ ok: true, accruedUsdMicros: 0n });
		expect(state.events).toHaveLength(0);
		expect(state.reservations[0]?.reconciliationRequiredAt).toBeTruthy();
	});

	it("settle over reserved hold reconciles without releasing spend", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 950n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 2,
				settledUsage: baseUsage,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({ ok: true, accruedUsdMicros: 0n });
		expect(state.events).toHaveLength(0);
		expect(state.reservations[0]?.reconciliationRequiredAt).toBeTruthy();
	});

	it("finalize compares aggregate persisted steps to accrued spend", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 10_000n,
			accruedUsdMicros: 200n,
			reconciliationRequiredAt: null,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			startedAt: new Date("2026-07-20T00:00:00.000Z"),
			expiresAt: new Date("2026-07-20T00:01:00.000Z"),
			updatedAt: new Date("2026-07-20T00:00:00.000Z"),
		});
		state.events.push({
			cacheReadTokens: 0n,
			cacheWriteTokens: 0n,
			id: "e1",
			model: "gpt-5.4-mini",
			outputTokens: 5n,
			priceEffectiveAt: config.priceBookEffectiveAt,
			priceVersion: config.priceBookVersion,
			provider: "openai",
			reasoningTokens: 0n,
			requestId: "r1",
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			stepIndex: 0,
			totalTokens: 55n,
			uncachedInputTokens: 50n,
			usdMicros: 100n,
		});
		state.events.push({
			cacheReadTokens: 0n,
			cacheWriteTokens: 0n,
			id: "e2",
			model: "gpt-5.4-mini",
			outputTokens: 5n,
			priceEffectiveAt: config.priceBookEffectiveAt,
			priceVersion: config.priceBookVersion,
			provider: "openai",
			reasoningTokens: 0n,
			requestId: "r1",
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			stepIndex: 1,
			totalTokens: 55n,
			uncachedInputTokens: 50n,
			usdMicros: 100n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.finalizeRequest({
				expectedStepCount: 2,
				finalAggregate: {
					cacheRead: 0n,
					cacheWrite: 0n,
					input: 100n,
					modality: "text",
					modelId: "gpt-5.4-mini",
					output: 10n,
					reasoning: 0n,
					provider: "openai",
					total: 110n,
					uncachedInput: 100n,
				},
				requestId: "r1",
				reconciliationRequired: false,
			})
		).toMatchObject({ ok: true, reconciliationRequired: false });
		expect(state.reservations[0]?.status).toBe("completed");
	});

	it("finalize reconciles on runtime pair mismatch or non-text modality", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r2",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 10_000n,
			accruedUsdMicros: 100n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		state.events.push({
			cacheReadTokens: 0n,
			cacheWriteTokens: 0n,
			id: "e1",
			model: "gpt-5.4-mini",
			outputTokens: 10n,
			priceEffectiveAt: config.priceBookEffectiveAt,
			priceVersion: config.priceBookVersion,
			provider: "openai",
			reasoningTokens: 0n,
			requestId: "r2",
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			stepIndex: 0,
			totalTokens: 10n,
			uncachedInputTokens: 10n,
			usdMicros: 100n,
		});
		const repo = createBillingRepository(state.db, config);
		await expect(
			repo.finalizeRequest({
				expectedStepCount: 1,
				finalAggregate: {
					cacheRead: 0n,
					cacheWrite: 0n,
					input: 10n,
					modality: "audio" as never,
					modelId: "gpt-5.4-mini",
					output: 10n,
					reasoning: 0n,
					provider: "openai",
					total: 20n,
					uncachedInput: 10n,
				},
				requestId: "r2",
				reconciliationRequired: false,
			})
		).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
		expect(state.reservations[0]?.status).toBe("reconciliation-required");
	});

	it("settle same step idempotent retains one usage row", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		await repo.settleStep({
			requestId: "r1",
			stepIndex: 1,
			settledUsage: baseUsage,
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
		});
		await repo.settleStep({
			requestId: "r1",
			stepIndex: 1,
			settledUsage: baseUsage,
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
		});
		expect(state.events).toHaveLength(1);
	});

	it("expiry marks reconciliationRequired", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			reconciliationRequiredAt: null,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			startedAt: new Date("2026-07-20T00:00:00.000Z"),
			expiresAt: new Date("2026-07-20T00:01:00.000Z"),
			updatedAt: new Date("2026-07-20T00:00:00.000Z"),
		});
		const repo = createBillingRepository(state.db, config);
		await repo.expireStaleActiveRequests(new Date("2026-07-21T00:00:00.000Z"));
		expect(state.reservations[0]?.status).toBe("expired");
		expect(state.reservations[0]?.reconciliationRequiredAt).toBeTruthy();
	});

	it("expiry marks reconciliationRequired", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			reconciliationRequiredAt: null,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			startedAt: new Date("2026-07-20T00:00:00.000Z"),
			expiresAt: new Date("2026-07-20T00:01:00.000Z"),
			updatedAt: new Date("2026-07-20T00:00:00.000Z"),
		});
		const repo = createBillingRepository(state.db, config);
		await repo.expireStaleActiveRequests(new Date("2026-07-21T00:00:00.000Z"));
		expect(state.reservations[0]?.status).toBe("expired");
		expect(state.reservations[0]?.reconciliationRequiredAt).toBeTruthy();
	});

	it("reserve includes cache-read hold and does not underhold", async () => {
		const state = createDb();
		const repo = createBillingRepository(state.db, config);
		await expect(
			repo.reserveRequest({
				requestId: "r9",
				userId: "user-1",
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			})
		).resolves.toMatchObject({ ok: true, reservedUsdMicros: 53_250_000n });
	});

	it("finalize + expiry state", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 120n,
			reconciliationRequiredAt: null,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			startedAt: new Date("2026-07-20T00:00:00.000Z"),
			expiresAt: new Date("2026-07-20T00:01:00.000Z"),
			updatedAt: new Date("2026-07-20T00:00:00.000Z"),
		});
		state.events.push({
			cacheReadTokens: 0n,
			cacheWriteTokens: 0n,
			id: "e1",
			model: "gpt-5.4-mini",
			outputTokens: 12n,
			priceEffectiveAt: config.priceBookEffectiveAt,
			priceVersion: config.priceBookVersion,
			provider: "openai",
			reasoningTokens: 0n,
			requestId: "r1",
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
			stepIndex: 0,
			totalTokens: 12n,
			uncachedInputTokens: 0n,
			usdMicros: 120n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.finalizeRequest({
				expectedStepCount: 1,
				finalAggregate: {
					cacheRead: 0n,
					cacheWrite: 0n,
					input: 0n,
					modality: "text",
					modelId: "gpt-5.4-mini",
					output: 12n,
					reasoning: 0n,
					provider: "openai",
					total: 12n,
					uncachedInput: 0n,
				},
				requestId: "r1",
				reconciliationRequired: false,
			})
		).toMatchObject({ ok: true, reconciliationRequired: false });
		expect(state.reservations[0]?.status).toBe("completed");
		expect(
			await repo.finalizeRequest({
				expectedStepCount: 2,
				finalAggregate: {
					cacheRead: 0n,
					cacheWrite: 0n,
					input: 0n,
					modality: "text",
					modelId: "gpt-5.4-mini",
					output: 0n,
					reasoning: 0n,
					provider: "openai",
					total: 0n,
					uncachedInput: 0n,
				},
				requestId: "r1",
				reconciliationRequired: false,
			})
		).toMatchObject({
			ok: false,
			kind: "unavailable",
			reason: "illegal-transition",
		});
		expect(
			await repo.expireStaleActiveRequests(new Date("2026-07-21T00:00:00.000Z"))
		).toMatchObject({ ok: true, expiredCount: 1 });
	});

	it("settle same step idempotent retains one usage row", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "active",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1_000n,
			accruedUsdMicros: 0n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		await repo.settleStep({
			requestId: "r1",
			stepIndex: 1,
			settledUsage: baseUsage,
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
		});
		await repo.settleStep({
			requestId: "r1",
			stepIndex: 1,
			settledUsage: baseUsage,
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
		});
		expect(state.events).toHaveLength(1);
	});

	it("settle rejects terminal state", async () => {
		const state = createDb();
		state.reservations.push({
			requestId: "r1",
			userId: "user-1",
			status: "completed",
			runtimeProvider: "openai",
			runtimeModel: "gpt-5.4-mini",
			reservedUsdMicros: 1n,
			accruedUsdMicros: 1n,
			priceVersion: config.priceBookVersion,
			priceEffectiveAt: config.priceBookEffectiveAt,
			rateInputUsdMicrosPerMillionTokens: 750000n,
			rateCacheReadUsdMicrosPerMillionTokens: 75000n,
			rateCacheWriteUsdMicrosPerMillionTokens: 0n,
			rateOutputUsdMicrosPerMillionTokens: 4500000n,
			rateReasoningUsdMicrosPerMillionTokens: 0n,
		});
		const repo = createBillingRepository(state.db, config);
		expect(
			await repo.settleStep({
				requestId: "r1",
				stepIndex: 2,
				settledUsage: baseUsage,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			})
		).toMatchObject({
			ok: false,
			kind: "unavailable",
			reason: "illegal-transition",
		});
	});
});
