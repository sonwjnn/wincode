import { describe, expect, it, mock } from "bun:test";
import { createBillingLifecycle } from "./lifecycle";
import type {
	BillingUsageAdapterInput,
	BillingUsageAdapterResult,
} from "./usage-adapter";

const sdkUsage = {
	inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: undefined },
	inputTokens: 12,
	outputTokenDetails: { reasoningTokens: 0 },
	outputTokens: 3,
	totalTokens: 15,
};

describe("billing lifecycle glue", () => {
	it("reserves, settles, and finalizes with SDK-shaped usage", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r1" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 12n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "enforce" },
			repository: repo as never,
			mode: "plan",
			requestId: "r1",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date("2026-07-20T00:00:00.000Z"),
			userId: "u1",
		});

		await expect(lifecycle.reserve()).resolves.toEqual({
			ok: true,
			requestId: "r1",
		});
		await expect(
			lifecycle.onStepEnd({
				stepNumber: 0,
				usage: sdkUsage,
			})
		).resolves.toBeUndefined();
		await expect(
			lifecycle.onEnd({
				steps: [{ stepNumber: 0, usage: sdkUsage }],
				totalUsage: {
					inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 0 },
					inputTokens: 12,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 3,
					totalTokens: 15,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.reserveRequest).toHaveBeenCalledTimes(1);
		expect(repo.settleStep).toHaveBeenCalledTimes(1);
		expect(repo.finalizeRequest).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedStepCount: 1,
				reconciliationRequired: false,
				requestId: "r1",
			})
		);
	});

	it("settles when cache write is undefined", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r2" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r2",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onStepEnd({
				stepNumber: 1,
				usage: {
					inputTokenDetails: {
						cacheReadTokens: 0,
						cacheWriteTokens: undefined,
					},
					inputTokens: 1,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 1,
					totalTokens: 2,
				},
			})
		).resolves.toBeUndefined();
		await expect(
			lifecycle.onEnd({
				steps: [{ stepNumber: 1, usage: sdkUsage }],
				totalUsage: {
					inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 0 },
					inputTokens: 12,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 3,
					totalTokens: 15,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.settleStep).toHaveBeenCalledTimes(1);
		expect(repo.finalizeRequest).toHaveBeenCalledWith({
			expectedStepCount: 1,
			finalAggregate: expect.objectContaining({
				cacheWrite: 0n,
			}),
			reconciliationRequired: false,
			requestId: "r2",
		});
	});

	it("reconciles on aggregate total mismatch", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r3" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r3",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onEnd({
				steps: [
					{
						stepNumber: 0,
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					},
				],
				totalUsage: {
					inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
					inputTokens: 2,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 1,
					totalTokens: 3,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStepCount: 1,
				reconciliationRequired: true,
				requestId: "r3",
			})
		);
	});

	it("reconciles when core end usage is missing", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r4" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r4",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onEnd({
				steps: [
					{
						stepNumber: 0,
						usage: undefined,
					},
				],
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStepCount: 1,
				reconciliationRequired: true,
				requestId: "r4",
			})
		);
	});

	it("reconciles when final aggregate steps drop a callback payload", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r5" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r5",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onEnd({
				steps: [
					{
						stepNumber: 0,
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					},
					{ stepNumber: 1, usage: undefined },
				],
				totalUsage: {
					inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
					inputTokens: 1,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 1,
					totalTokens: 2,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStepCount: 2,
				reconciliationRequired: true,
				requestId: "r5",
			})
		);
	});

	it("reconciles when core aggregate usage is missing", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r6" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r6",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onEnd({
				steps: [],
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStepCount: 0,
				reconciliationRequired: true,
				requestId: "r6",
			})
		);
	});

	it("reconciles when end usage is incomplete", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r8" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r8",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});

		await expect(
			lifecycle.onEnd({
				steps: [{ stepNumber: 0, usage: sdkUsage }],
				usage: {
					inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 0 },
					inputTokens: 12,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 3,
					totalTokens: 15,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedStepCount: 1,
				reconciliationRequired: true,
				requestId: "r8",
			})
		);
	});

	it("correlates end usage to final used step", async () => {
		const adaptedSteps: number[] = [];
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r7" })),
			settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle(
			{
				config: { mode: "allowlist-shadow" },
				repository: repo as never,
				mode: "plan",
				requestId: "r7",
				runtimeModel: "gpt-5.4-mini",
				runtimeProvider: "openai",
				startedAt: new Date(),
				userId: "u1",
			},
			{
				adaptUsage: (
					_requestId: string,
					stepIndex: number,
					_usage: BillingUsageAdapterInput
				): BillingUsageAdapterResult => {
					adaptedSteps.push(stepIndex);
					return {
						stepId: `billing:r7:${stepIndex}`,
						reconciliationRequired: false,
						usage: {
							cacheRead: 0n,
							cacheWrite: 0n,
							input: 1n,
							modality: "text",
							modelId: "gpt-5.4-mini",
							provider: "openai",
							output: 1n,
							reasoning: 0n,
							total: 2n,
							uncachedInput: 1n,
						},
					};
				},
			}
		);

		await expect(
			lifecycle.onEnd({
				steps: [
					{
						stepNumber: 0,
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					},
					{
						stepNumber: 1,
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					},
					{
						stepNumber: 2,
						usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
					},
				],
				totalUsage: {
					inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
					inputTokens: 5,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 6,
					totalTokens: 11,
				},
			})
		).resolves.toBeUndefined();

		expect(adaptedSteps).toEqual([2]);
	});

	it("finalizes cleanly after failed settle then good end", async () => {
		const repo = {
			finalizeRequest: mock(async () => ({
				ok: true,
				reconciliationRequired: false,
			})),
			reserveRequest: mock(async () => ({ ok: true, requestId: "r9" })),
			settleStep: mock(async () => ({
				ok: false,
				kind: "unavailable",
				reason: "db",
			})),
			expireStaleActiveRequests: mock(async () => ({
				ok: true,
				expiredCount: 0,
			})),
		};
		const lifecycle = createBillingLifecycle({
			config: { mode: "allowlist-shadow" },
			repository: repo as never,
			mode: "plan",
			requestId: "r9",
			runtimeModel: "gpt-5.4-mini",
			runtimeProvider: "openai",
			startedAt: new Date(),
			userId: "u1",
		});
		repo.finalizeRequest.mockImplementationOnce(async () => {
			throw new Error("db");
		});

		await expect(
			lifecycle.onStepEnd({
				stepNumber: 0,
				usage: sdkUsage,
			})
		).resolves.toBeUndefined();
		await expect(
			lifecycle.onEnd({
				steps: [{ stepNumber: 0, usage: sdkUsage }],
				totalUsage: {
					inputTokenDetails: {
						cacheReadTokens: 2,
						cacheWriteTokens: undefined,
					},
					inputTokens: 12,
					outputTokenDetails: { reasoningTokens: 0 },
					outputTokens: 3,
					totalTokens: 15,
				},
			})
		).resolves.toBeUndefined();

		expect(repo.finalizeRequest).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedStepCount: 1,
				reconciliationRequired: true,
				requestId: "r9",
			})
		);
	});
});
