import type { BillingRepository } from "./repository";
import type { BillingNormalizedUsage } from "./types";
import { adaptBillingUsage } from "./usage-adapter";

export type BillingLifecycleConfig = {
	readonly mode: "disabled" | "allowlist-shadow" | "canary-enforce" | "enforce";
};

export type BillingLifecycleContext = {
	readonly config: BillingLifecycleConfig | null;
	readonly repository: BillingRepository | null;
	readonly requestId: string;
	readonly userId: string;
	readonly startedAt: Date;
	readonly runtimeProvider: string;
	readonly runtimeModel: string;
	readonly mode: string;
};

export type BillingLifecycleDeps = {
	readonly adaptUsage?: typeof adaptBillingUsage;
};

export type BillingLifecycleStepEndEvent = {
	readonly stepNumber?: number;
	readonly usage?: {
		readonly inputTokens?: bigint | number;
		readonly outputTokens?: bigint | number;
		readonly totalTokens?: bigint | number;
		readonly inputTokenDetails?: {
			readonly cacheReadTokens?: bigint | number | null | undefined;
			readonly cacheWriteTokens?: bigint | number | null | undefined;
		};
		readonly outputTokenDetails?: {
			readonly reasoningTokens?: bigint | number | null | undefined;
		};
	};
};

export type BillingLifecycleEndEvent = {
	readonly steps?: readonly BillingLifecycleStepEndEvent[];
	readonly usage?: BillingLifecycleStepEndEvent["usage"];
	readonly totalUsage?: BillingLifecycleStepEndEvent["usage"];
};

export type BillingLifecycle = {
	readonly reserve: () => Promise<
		| { readonly ok: true; readonly requestId: string }
		| { readonly ok: false; readonly kind: string; readonly reason: string }
	>;
	readonly onStepEnd: (event: BillingLifecycleStepEndEvent) => Promise<void>;
	readonly onEnd: (event: BillingLifecycleEndEvent) => Promise<void>;
};

const isBillingUnavailable = (config: BillingLifecycleConfig | null): boolean =>
	config === null || config.mode === "disabled";

const toStepIndex = (stepNumber: number | undefined): number =>
	typeof stepNumber === "number" && Number.isFinite(stepNumber)
		? stepNumber
		: 0;

const toUsageBigint = (value: bigint | number | null | undefined): bigint =>
	typeof value === "bigint" ? value : BigInt(value ?? 0);

const sumStepUsage = (
	steps: readonly BillingLifecycleStepEndEvent[]
): NonNullable<BillingLifecycleStepEndEvent["usage"]> | null => {
	if (steps.length === 0) {
		return null;
	}
	let inputTokens = 0n;
	let outputTokens = 0n;
	let totalTokens = 0n;
	let cacheReadTokens = 0n;
	let cacheWriteTokens = 0n;
	let reasoningTokens = 0n;
	for (const step of steps) {
		const usage = step.usage;
		if (!usage) {
			return null;
		}
		inputTokens += toUsageBigint(usage.inputTokens);
		outputTokens += toUsageBigint(usage.outputTokens);
		totalTokens += toUsageBigint(usage.totalTokens);
		cacheReadTokens += toUsageBigint(usage.inputTokenDetails?.cacheReadTokens);
		cacheWriteTokens += toUsageBigint(
			usage.inputTokenDetails?.cacheWriteTokens
		);
		reasoningTokens += toUsageBigint(usage.outputTokenDetails?.reasoningTokens);
	}
	return {
		inputTokenDetails: {
			cacheReadTokens,
			cacheWriteTokens,
		},
		inputTokens,
		outputTokenDetails: { reasoningTokens },
		outputTokens,
		totalTokens,
	};
};

const getFinalUsageStepNumber = (
	steps: readonly BillingLifecycleStepEndEvent[]
): number => {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const step = steps[index];
		if (step?.usage) {
			return toStepIndex(step.stepNumber);
		}
	}
	return 0;
};

const getUsageTotals = (
	usage: NonNullable<BillingLifecycleStepEndEvent["usage"]>
) => ({
	cacheReadTokens: toUsageBigint(usage.inputTokenDetails?.cacheReadTokens),
	cacheWriteTokens: toUsageBigint(usage.inputTokenDetails?.cacheWriteTokens),
	inputTokens: toUsageBigint(usage.inputTokens),
	outputTokens: toUsageBigint(usage.outputTokens),
	reasoningTokens: toUsageBigint(usage.outputTokenDetails?.reasoningTokens),
	totalTokens: toUsageBigint(usage.totalTokens),
});

const hasCompleteStepUsage = (
	steps: readonly BillingLifecycleStepEndEvent[]
): boolean => steps.every((step) => step.usage !== undefined);

const hasCompleteUsageTotals = (
	usage: BillingLifecycleStepEndEvent["usage"]
): usage is NonNullable<BillingLifecycleStepEndEvent["usage"]> =>
	usage !== undefined &&
	usage.inputTokens !== undefined &&
	usage.outputTokens !== undefined &&
	usage.totalTokens !== undefined &&
	usage.inputTokenDetails?.cacheReadTokens !== undefined &&
	usage.outputTokenDetails?.reasoningTokens !== undefined;

const usageTotalsMatch = (
	aggregateUsage: BillingLifecycleStepEndEvent["usage"],
	reportedUsage: NonNullable<BillingLifecycleEndEvent["totalUsage"]>
): boolean => {
	if (!aggregateUsage) {
		return false;
	}
	const aggregateTotals = getUsageTotals(aggregateUsage);
	const reportedTotals = getUsageTotals(reportedUsage);
	return (
		aggregateTotals.inputTokens === reportedTotals.inputTokens &&
		aggregateTotals.outputTokens === reportedTotals.outputTokens &&
		aggregateTotals.totalTokens === reportedTotals.totalTokens &&
		aggregateTotals.cacheReadTokens === reportedTotals.cacheReadTokens &&
		aggregateTotals.cacheWriteTokens === reportedTotals.cacheWriteTokens &&
		aggregateTotals.reasoningTokens === reportedTotals.reasoningTokens
	);
};

const needsEndReconciliation = (event: BillingLifecycleEndEvent): boolean => {
	if (!hasCompleteStepUsage(event.steps ?? [])) {
		return true;
	}
	if (event.usage !== undefined && !hasCompleteUsageTotals(event.usage)) {
		return true;
	}
	if (
		event.totalUsage !== undefined &&
		!hasCompleteUsageTotals(event.totalUsage)
	) {
		return true;
	}
	const aggregateUsage = sumStepUsage(event.steps ?? []);
	const usage = event.totalUsage ?? event.usage ?? aggregateUsage;
	if (!usage) {
		return true;
	}
	if (
		aggregateUsage !== null &&
		event.totalUsage !== undefined &&
		!usageTotalsMatch(aggregateUsage, event.totalUsage)
	) {
		return true;
	}
	return aggregateUsage !== null && !event.totalUsage;
};

export const createBillingLifecycle = (
	context: BillingLifecycleContext,
	deps: BillingLifecycleDeps = {}
): BillingLifecycle => {
	const adaptUsage = deps.adaptUsage ?? adaptBillingUsage;
	let reconcileFailed = false;
	const reconcile = async (
		expectedStepCount: number,
		finalAggregate: BillingLifecycleStepEndEvent["usage"] | null = null
	): Promise<void> => {
		reconcileFailed = true;
		const normalized = finalAggregate
			? adaptUsage(context.requestId, 0, toUsageInput(finalAggregate)).usage
			: undefined;
		try {
			await context.repository?.finalizeRequest({
				expectedStepCount,
				finalAggregate: normalized as BillingNormalizedUsage,
				reconciliationRequired: true,
				requestId: context.requestId,
			});
		} catch {
			return;
		}
	};
	const reserve = async (): Promise<
		| { readonly ok: true; readonly requestId: string }
		| { readonly ok: false; readonly kind: string; readonly reason: string }
	> => {
		if (isBillingUnavailable(context.config) || !context.repository) {
			return { ok: false, kind: "unavailable", reason: "billing-disabled" };
		}
		try {
			return await context.repository.reserveRequest({
				mode: context.mode,
				requestId: context.requestId,
				runtimeModel: context.runtimeModel,
				runtimeProvider: context.runtimeProvider,
				startedAt: context.startedAt,
				userId: context.userId,
			});
		} catch {
			return { ok: false, kind: "unavailable", reason: "billing-disabled" };
		}
	};

	const toUsageInput = (
		usage: NonNullable<BillingLifecycleStepEndEvent["usage"]>
	) => ({
		inputTokenDetails: usage.inputTokenDetails,
		inputTokens: usage.inputTokens ?? 0n,
		outputTokenDetails: usage.outputTokenDetails,
		outputTokens: usage.outputTokens ?? 0n,
		totalTokens: usage.totalTokens ?? 0n,
		provider: context.runtimeProvider,
		modelId: context.runtimeModel,
	});

	const settle = async (event: BillingLifecycleStepEndEvent): Promise<void> => {
		if (isBillingUnavailable(context.config) || !context.repository) {
			return;
		}
		const usage = event.usage;
		if (!usage) {
			reconcileFailed = true;
			await reconcile(0);
			return;
		}
		const stepIndex = toStepIndex(event.stepNumber);
		let adapted: ReturnType<typeof adaptUsage>;
		try {
			adapted = adaptUsage(context.requestId, stepIndex, toUsageInput(usage));
		} catch {
			reconcileFailed = true;
			await reconcile(0, usage);
			return;
		}
		if (!adapted.usage || adapted.reconciliationRequired) {
			reconcileFailed = true;
			await reconcile(0, usage);
			return;
		}
		try {
			const settled = await context.repository.settleStep({
				requestId: context.requestId,
				runtimeModel: context.runtimeModel,
				runtimeProvider: context.runtimeProvider,
				settledUsage: adapted.usage,
				stepIndex,
			});
			if (!settled.ok) {
				reconcileFailed = true;
				await reconcile(0, usage);
			}
		} catch {
			reconcileFailed = true;
			await reconcile(0, usage);
		}
	};

	const finalize = async (event: BillingLifecycleEndEvent): Promise<void> => {
		const repository = context.repository;
		if (!repository) {
			return;
		}
		const steps = event.steps ?? [];
		if (needsEndReconciliation(event)) {
			await reconcile(steps.length);
			return;
		}
		const aggregateUsage = sumStepUsage(steps);
		const finalUsage = event.totalUsage ?? event.usage ?? aggregateUsage;
		if (!finalUsage) {
			reconcileFailed = true;
			await reconcile(steps.length);
			return;
		}
		let adapted: ReturnType<typeof adaptUsage>;
		try {
			adapted = adaptUsage(
				context.requestId,
				getFinalUsageStepNumber(steps),
				toUsageInput(finalUsage)
			);
		} catch {
			reconcileFailed = true;
			await reconcile(steps.length, finalUsage);
			return;
		}
		if (aggregateUsage && !event.totalUsage) {
			await reconcile(steps.length, finalUsage);
			return;
		}
		const normalizedUsage = adapted.usage;
		try {
			await repository.finalizeRequest({
				expectedStepCount: steps.length,
				finalAggregate: normalizedUsage as BillingNormalizedUsage,
				reconciliationRequired:
					adapted.reconciliationRequired ||
					adapted.usage === null ||
					reconcileFailed,
				requestId: context.requestId,
			});
		} catch {
			reconcileFailed = true;
			await reconcile(steps.length, finalUsage);
		}
	};

	const onEnd = async (event: BillingLifecycleEndEvent): Promise<void> => {
		if (isBillingUnavailable(context.config) || !context.repository) {
			return;
		}
		await finalize(event);
	};

	return { onEnd, onStepEnd: settle, reserve };
};
