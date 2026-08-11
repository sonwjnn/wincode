import { describe, expect, it } from "bun:test";
import { Pool } from "@neondatabase/serverless";
import { billingPricebook } from "@wincode/billing/pricing";
import {
	billingRequestReservation,
	billingSubscription,
	billingUsageEvent,
	user,
} from "@wincode/db/schema";
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createBillingRepository } from "../../../src/billing/repository";

const databaseUrl = process.env.DATABASE_URL;
const hasDatabaseUrl = Boolean(databaseUrl);

const schema = {
	billingRequestReservation,
	billingSubscription,
	billingUsageEvent,
	user,
};
const db = drizzle(
	new Pool({
		connectionString: databaseUrl ?? "postgres://localhost/wincode-test",
	}),
	{ schema }
);
const repo = createBillingRepository(db, {
	alphaUserAllowlist: new Set<string>(),
	dailyGlobalCostCapUsdMicros: 100_000_000n,
	fundedRequestInputTokenLimit: 1_000_000n,
	fundedRequestOutputTokenLimit: 1_000_000n,
	fundedRequestStepLimit: 10n,
	fundedRequestTimeWindowSeconds: 900n,
	modelKillSwitches: new Set<string>(),
	mode: "enforce",
	priceBookEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
	priceBookVersion: billingPricebook.version,
	providerKillSwitches: new Set<string>(),
	goProductId: "go_product",
	goRollingQuotaUsdMicros: 100_000_000n,
});
const makeRepo = (
	mode: "allowlist-shadow" | "canary-enforce",
	userId: string
) =>
	createBillingRepository(db, {
		alphaUserAllowlist: new Set([userId]),
		dailyGlobalCostCapUsdMicros: 100_000_000n,
		fundedRequestInputTokenLimit: 1_000_000n,
		fundedRequestOutputTokenLimit: 1_000_000n,
		fundedRequestStepLimit: 10n,
		fundedRequestTimeWindowSeconds: 900n,
		modelKillSwitches: new Set<string>(),
		mode,
		priceBookEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
		priceBookVersion: billingPricebook.version,
		providerKillSwitches: new Set<string>(),
		goProductId: "go_product",
		goRollingQuotaUsdMicros: 100_000_000n,
	});
const prefix = `billing_pg_${crypto.randomUUID()}`;
const insertEntitlement = async (userId: string, productId = "go_product") => {
	await db.insert(billingSubscription).values({
		id: `${userId}_sub`,
		userId,
		provider: "local",
		providerSubscriptionId: `${userId}_provider_sub`,
		providerCustomerId: `${userId}_customer`,
		providerProductId: productId,
		eventSource: "test",
		eventAt: new Date("2026-07-20T00:00:00.000Z"),
		status: "active",
		currentPeriodStartAt: new Date("2026-07-01T00:00:00.000Z"),
		currentPeriodEndAt: new Date("2026-08-01T00:00:00.000Z"),
	});
};

const cleanupFixture = async () => {
	await db
		.delete(billingUsageEvent)
		.where(like(billingUsageEvent.requestId, `${prefix}%`));
	await db
		.delete(billingRequestReservation)
		.where(like(billingRequestReservation.requestId, `${prefix}%`));
	await db
		.delete(billingSubscription)
		.where(like(billingSubscription.id, `${prefix}%`));
	await db.delete(user).where(like(user.id, `${prefix}%`));
};

describe.skipIf(!hasDatabaseUrl)("billing repository pg", () => {
	it("expired entitlement reserve/settle/finalize", async () => {
		const userId = `${prefix}_u1`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			await insertEntitlement(userId);
			const reservationId = `${prefix}_r1`;
			expect(
				await repo.reserveRequest({
					requestId: reservationId,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true, requestId: reservationId });
			expect(
				await repo.settleStep({
					requestId: reservationId,
					stepIndex: 1,
					settledUsage: {
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
					},
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
				})
			).toMatchObject({ ok: true, accruedUsdMicros: 120n });
			expect(
				await repo.finalizeRequest({
					expectedStepCount: 1,
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
					requestId: reservationId,
					reconciliationRequired: false,
				})
			).toMatchObject({ ok: true, reconciliationRequired: false });
			expect(
				await db
					.select()
					.from(billingRequestReservation)
					.where(like(billingRequestReservation.requestId, `${prefix}%`))
			).toHaveLength(1);
		} finally {
			await cleanupFixture();
		}
	});

	it("same-step idempotency keeps one event", async () => {
		const userId = `${prefix}_u5`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r4`;
			await insertEntitlement(userId);
			await repo.reserveRequest({
				requestId: reservationId,
				userId,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			});
			await repo.settleStep({
				requestId: reservationId,
				stepIndex: 0,
				settledUsage: {
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
				},
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			});
			await repo.settleStep({
				requestId: reservationId,
				stepIndex: 0,
				settledUsage: {
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
				},
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
			});
			const rows = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.accruedUsdMicros).toBe(120n);
		} finally {
			await cleanupFixture();
		}
	});

	it("unresolved exposure blocks duplicate active user until terminal", async () => {
		const userId = `${prefix}_u7`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r5`;
			await insertEntitlement(userId);
			await db.insert(user).values({
				id: `${prefix}_u10b`,
				name: `${prefix}_u10b`,
				email: `${prefix}_u10b@example.com`,
				emailVerified: true,
			});
			await insertEntitlement(`${prefix}_u10b`);
			expect(
				await repo.reserveRequest({
					requestId: reservationId,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true, requestId: reservationId });

			await db
				.update(billingRequestReservation)
				.set({ reconciliationRequiredAt: new Date("2026-07-20T03:10:00.000Z") })
				.where(like(billingRequestReservation.requestId, reservationId));

			expect(
				await repo.reserveRequest({
					requestId: `${prefix}_r5b`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:01:00.000Z"),
				})
			).toMatchObject({
				ok: false,
				kind: "denied",
				reason: "rolling-quota",
			});

			await db
				.update(billingRequestReservation)
				.set({ status: "reconciliation-required" })
				.where(like(billingRequestReservation.requestId, reservationId));

			expect(
				await repo.reserveRequest({
					requestId: `${prefix}_r5c`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:02:00.000Z"),
				})
			).toMatchObject({
				ok: false,
				kind: "denied",
				reason: "rolling-quota",
			});

			await db
				.update(billingRequestReservation)
				.set({ status: "completed" })
				.where(like(billingRequestReservation.requestId, reservationId));

			expect(
				await repo.reserveRequest({
					requestId: `${prefix}_r5c`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:02:00.000Z"),
				})
			).toMatchObject({ ok: true, requestId: `${prefix}_r5c` });
		} finally {
			await cleanupFixture();
		}
	});

	it("hold stays bounded by input and output once", async () => {
		const userId = `${prefix}_u8`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r8`;
			await insertEntitlement(userId);
			const response = await repo.reserveRequest({
				requestId: reservationId,
				userId,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			});
			expect(response).toMatchObject({ ok: true, requestId: reservationId });
			const [reservation] = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(reservation?.reservedUsdMicros).toBe(53_250_000n);
		} finally {
			await cleanupFixture();
		}
	});

	it("gemini 999999+1 split settlement rounds up hold", async () => {
		const userId = `${prefix}_u9`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r9`;
			await insertEntitlement(userId);
			await repo.reserveRequest({
				requestId: reservationId,
				userId,
				runtimeProvider: "google",
				runtimeModel: "gemini-2.5-flash",
				mode: "plan",
				startedAt: new Date("2026-07-20T03:00:00.000Z"),
			});
			const [reservation] = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(reservation?.reservedUsdMicros).toBe(28_300_000n);
		} finally {
			await cleanupFixture();
		}
	});

	it("concurrent quota crossing rejects one reserve", async () => {
		const userA = `${prefix}_u6a`;
		const userB = `${prefix}_u6b`;
		try {
			await db.insert(user).values([
				{
					id: userA,
					name: userA,
					email: `${userA}@example.com`,
					emailVerified: true,
				},
				{
					id: userB,
					name: userB,
					email: `${userB}@example.com`,
					emailVerified: true,
				},
			]);
			await insertEntitlement(userA);
			await insertEntitlement(userB);
			const [a, b] = await Promise.all([
				repo.reserveRequest({
					requestId: `${prefix}_ra`,
					userId: userA,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				}),
				repo.reserveRequest({
					requestId: `${prefix}_rb`,
					userId: userB,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				}),
			]);
			expect([a.ok, b.ok]).toEqual([true, false]);
			expect([a, b].filter((result) => !result.ok)).toHaveLength(1);
			expect([a, b].find((result) => !result.ok)).toMatchObject({
				ok: false,
				kind: "denied",
				reason: "daily-cap",
			});
			const reservations = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, `${prefix}%`));
			expect(reservations).toHaveLength(1);
		} finally {
			await cleanupFixture();
		}
	});

	it("expired hold preserves unresolved exposure; late settle rejected", async () => {
		const userId = `${prefix}_u3`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r2`;
			await insertEntitlement(userId);
			expect(
				await repo.reserveRequest({
					requestId: reservationId,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true, requestId: reservationId });
			await db
				.update(billingRequestReservation)
				.set({ reconciliationRequiredAt: new Date("2026-07-20T03:10:00.000Z") })
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(
				await repo.expireStaleActiveRequests(
					new Date("2026-07-21T00:00:00.000Z")
				)
			).toMatchObject({ ok: true });
			const expired = await repo.expireStaleActiveRequests(
				new Date("2026-07-21T00:00:00.000Z")
			);
			expect(expired).toMatchObject({ ok: true });
			await db.insert(user).values({
				id: `${prefix}_u3b`,
				name: `${prefix}_u3b`,
				email: `${prefix}_u3b@example.com`,
				emailVerified: true,
			});
			await insertEntitlement(`${prefix}_u3b`);
			expect(
				await repo.reserveRequest({
					requestId: `${prefix}_r2b`,
					userId: `${prefix}_u3b`,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:30:00.000Z"),
				})
			).toMatchObject({ ok: false, kind: "denied", reason: "daily-cap" });
			const [reservation] = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(reservation?.status).toBe("expired");
			expect(reservation?.reservedUsdMicros).toBe(53_250_000n);
			expect(reservation?.reconciliationRequiredAt).toBeTruthy();
			expect(
				await repo.settleStep({
					requestId: reservationId,
					stepIndex: 1,
					settledUsage: {
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
					},
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
				})
			).toMatchObject({
				ok: false,
				kind: "unavailable",
				reason: "illegal-transition",
			});
		} finally {
			await cleanupFixture();
		}
	});

	it("same-user concurrent reserve -> one row", async () => {
		const userId = `${prefix}_u2`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			await insertEntitlement(userId);
			const [a, b] = await Promise.all([
				repo.reserveRequest({
					requestId: `${prefix}_a`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				}),
				repo.reserveRequest({
					requestId: `${prefix}_b`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				}),
			]);
			expect([a.ok, b.ok]).toContain(false);
			expect([a.ok, b.ok]).toContain(true);
		} finally {
			await cleanupFixture();
		}
	});

	it("rolling 30d cutoff counts unresolved exposure across UTC day", async () => {
		const userId = `${prefix}_u10`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			await db.insert(billingRequestReservation).values({
				requestId: `${prefix}_hold`,
				userId,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				status: "active",
				reservedUsdMicros: 53_250_000n,
				accruedUsdMicros: 120n,
				priceVersion: billingPricebook.version,
				priceEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
				rateInputUsdMicrosPerMillionTokens: 750000n,
				rateCacheReadUsdMicrosPerMillionTokens: 75000n,
				rateCacheWriteUsdMicrosPerMillionTokens: 0n,
				rateOutputUsdMicrosPerMillionTokens: 4500000n,
				rateReasoningUsdMicrosPerMillionTokens: 0n,
				startedAt: new Date("2026-07-19T23:59:00.000Z"),
				expiresAt: new Date("2026-07-20T00:10:00.000Z"),
				updatedAt: new Date("2026-07-19T23:59:00.000Z"),
			});
			const reservationId = `${prefix}_r10`;
			await insertEntitlement(userId);
			expect(
				await repo.reserveRequest({
					requestId: reservationId,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T00:01:00.000Z"),
				})
			).toMatchObject({ ok: false, kind: "denied", reason: "rolling-quota" });
		} finally {
			await cleanupFixture();
		}
	});

	it("same-user rolling usage releases after 30-day cutoff", async () => {
		const userId = `${prefix}_cutoff`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			await insertEntitlement(userId);
			await db.insert(billingRequestReservation).values({
				requestId: `${prefix}_old`,
				userId,
				runtimeProvider: "openai",
				runtimeModel: "gpt-5.4-mini",
				mode: "plan",
				status: "completed",
				reservedUsdMicros: 0n,
				accruedUsdMicros: 0n,
				priceVersion: billingPricebook.version,
				priceEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
				rateInputUsdMicrosPerMillionTokens: 750000n,
				rateCacheReadUsdMicrosPerMillionTokens: 75000n,
				rateCacheWriteUsdMicrosPerMillionTokens: 0n,
				rateOutputUsdMicrosPerMillionTokens: 4500000n,
				rateReasoningUsdMicrosPerMillionTokens: 0n,
				startedAt: new Date("2026-06-19T00:00:00.000Z"),
				expiresAt: new Date("2026-06-19T00:10:00.000Z"),
				updatedAt: new Date("2026-06-19T00:10:00.000Z"),
			});
			await db.insert(billingUsageEvent).values({
				id: `${prefix}_old_event`,
				userId,
				requestId: `${prefix}_old`,
				stepIndex: 0,
				provider: "openai",
				model: "gpt-5.4-mini",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				usdMicros: 150_000_000n,
				priceVersion: billingPricebook.version,
				priceEffectiveAt: new Date("2026-07-19T00:00:00.000Z"),
				rateInputUsdMicrosPerMillionTokens: 750000n,
				rateCacheReadUsdMicrosPerMillionTokens: 75000n,
				rateCacheWriteUsdMicrosPerMillionTokens: 0n,
				rateOutputUsdMicrosPerMillionTokens: 4500000n,
				rateReasoningUsdMicrosPerMillionTokens: 0n,
				recordedAt: new Date("2026-06-19T00:00:00.000Z"),
			});
			expect(
				await repo.reserveRequest({
					requestId: `${prefix}_cutoff_r`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T00:00:00.000Z"),
				})
			).toMatchObject({ ok: true });
		} finally {
			await cleanupFixture();
		}
	});

	it("settle reconciles when parsed usage runtime pair differs", async () => {
		const userId = `${prefix}_u4`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const reservationId = `${prefix}_r3`;
			await insertEntitlement(userId);
			expect(
				await repo.reserveRequest({
					requestId: reservationId,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true, requestId: reservationId });
			expect(
				await repo.settleStep({
					requestId: reservationId,
					stepIndex: 1,
					settledUsage: {
						provider: "google",
						modelId: "gemini-2.5-flash",
						input: 100n,
						uncachedInput: 100n,
						cacheRead: 0n,
						cacheWrite: 0n,
						output: 10n,
						reasoning: 0n,
						total: 110n,
						modality: "text",
					},
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
				})
			).toMatchObject({ ok: true, accruedUsdMicros: 0n });
			const [reservation] = await db
				.select()
				.from(billingRequestReservation)
				.where(like(billingRequestReservation.requestId, reservationId));
			expect(reservation?.reconciliationRequiredAt).toBeTruthy();
			expect(
				await db
					.select()
					.from(billingUsageEvent)
					.where(like(billingUsageEvent.requestId, reservationId))
			).toHaveLength(0);
		} finally {
			await cleanupFixture();
		}
	});

	it("missing, wrong-product, and expired entitlements deny", async () => {
		const users = [`${prefix}_missing`, `${prefix}_wrong`, `${prefix}_expired`];
		try {
			await db.insert(user).values(
				users.map((id) => ({
					id,
					name: id,
					email: `${id}@example.com`,
					emailVerified: true,
				}))
			);
			await insertEntitlement(users[1] ?? "", "other_product");
			await db.insert(billingSubscription).values({
				id: `${users[2]}_sub`,
				userId: users[2] ?? "",
				provider: "local",
				providerSubscriptionId: `${users[2]}_provider_sub`,
				providerCustomerId: `${users[2]}_customer`,
				providerProductId: "go_product",
				eventSource: "test",
				eventAt: new Date("2026-07-20T00:00:00.000Z"),
				status: "active",
				currentPeriodStartAt: new Date("2026-06-01T00:00:00.000Z"),
				currentPeriodEndAt: new Date("2026-07-01T00:00:00.000Z"),
			});
			for (const userId of users) {
				expect(
					await repo.reserveRequest({
						requestId: `${userId}_request`,
						userId,
						runtimeProvider: "openai",
						runtimeModel: "gpt-5.4-mini",
						mode: "plan",
						startedAt: new Date("2026-07-20T03:00:00.000Z"),
					})
				).toMatchObject({ ok: false, kind: "denied", reason: "not-entitled" });
			}
		} finally {
			await cleanupFixture();
		}
	});

	it("allowlist shadow bypasses entitlement checks", async () => {
		const userId = `${prefix}_shadow`;
		try {
			await db.insert(user).values({
				id: userId,
				name: userId,
				email: `${userId}@example.com`,
				emailVerified: true,
			});
			const shadowRepo = makeRepo("allowlist-shadow", userId);
			expect(
				await shadowRepo.reserveRequest({
					requestId: `${prefix}_shadow_r`,
					userId,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true });
		} finally {
			await cleanupFixture();
		}
	});

	it("canary requires allowlist and entitlement", async () => {
		const allowed = `${prefix}_canary_allowed`;
		const denied = `${prefix}_canary_denied`;
		try {
			await db.insert(user).values([
				{
					id: allowed,
					name: allowed,
					email: `${allowed}@example.com`,
					emailVerified: true,
				},
				{
					id: denied,
					name: denied,
					email: `${denied}@example.com`,
					emailVerified: true,
				},
			]);
			await insertEntitlement(allowed);
			const canaryRepo = makeRepo("canary-enforce", allowed);
			expect(
				await canaryRepo.reserveRequest({
					requestId: `${prefix}_canary_ok`,
					userId: allowed,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: true });
			expect(
				await canaryRepo.reserveRequest({
					requestId: `${prefix}_canary_no`,
					userId: denied,
					runtimeProvider: "openai",
					runtimeModel: "gpt-5.4-mini",
					mode: "plan",
					startedAt: new Date("2026-07-20T03:00:00.000Z"),
				})
			).toMatchObject({ ok: false, reason: "not-allowlisted" });
		} finally {
			await cleanupFixture();
		}
	});
});
