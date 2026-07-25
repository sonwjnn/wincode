import type { BillingNormalizedUsage } from "./types";

export type BillingUsageAdapterInput = {
	readonly provider: string;
	readonly modelId: string;
	readonly modality?: string;
	readonly inputTokens: bigint | number;
	readonly outputTokens: bigint | number;
	readonly totalTokens: bigint | number;
	readonly inputTokenDetails?: {
		readonly cacheReadTokens?: bigint | number | null | undefined;
		readonly cacheWriteTokens?: bigint | number | null | undefined;
	};
	readonly outputTokenDetails?: {
		readonly reasoningTokens?: bigint | number | null | undefined;
	};
};

export type BillingUsageAdapterResult = {
	readonly stepId: string;
	readonly reconciliationRequired: boolean;
	readonly usage: BillingNormalizedUsage | null;
};

const toBigint = (
	value: bigint | number | null | undefined,
	fieldName: string
): bigint => {
	if (value === null || value === undefined) {
		throw new Error(`missing ${fieldName}`);
	}
	return typeof value === "bigint" ? value : BigInt(value);
};

export const buildBillingStepId = (
	requestId: string,
	stepIndex: number
): string => `billing:${requestId}:${stepIndex}`;

export const adaptBillingUsage = (
	requestId: string,
	stepIndex: number,
	usage: BillingUsageAdapterInput
): BillingUsageAdapterResult => {
	const stepId = buildBillingStepId(requestId, stepIndex);
	const cacheReadValue = usage.inputTokenDetails?.cacheReadTokens;
	const cacheWriteValue = usage.inputTokenDetails?.cacheWriteTokens;
	const reasoningValue = usage.outputTokenDetails?.reasoningTokens;
	const reconciliationRequired =
		cacheReadValue === null ||
		cacheReadValue === undefined ||
		cacheWriteValue === null ||
		reasoningValue === null ||
		reasoningValue === undefined;
	if (reconciliationRequired) {
		return { stepId, reconciliationRequired: true, usage: null };
	}

	const cacheReadTokens = toBigint(cacheReadValue, "cacheReadTokens");
	const cacheWriteTokens =
		cacheWriteValue === undefined
			? 0n
			: toBigint(cacheWriteValue, "cacheWriteTokens");
	const reasoningTokens = toBigint(reasoningValue, "reasoningTokens");

	const inputTokens = toBigint(usage.inputTokens, "inputTokens");
	const outputTokens = toBigint(usage.outputTokens, "outputTokens");
	const totalTokens = toBigint(usage.totalTokens, "totalTokens");
	const normalizedInput = inputTokens - cacheReadTokens;

	if (
		normalizedInput < 0n ||
		cacheWriteTokens !== 0n ||
		totalTokens !== inputTokens + outputTokens ||
		(usage.modality !== undefined && usage.modality !== "text")
	) {
		return { stepId, reconciliationRequired: true, usage: null };
	}

	return {
		stepId,
		reconciliationRequired,
		usage: {
			provider: usage.provider,
			modelId: usage.modelId,
			input: inputTokens,
			uncachedInput: normalizedInput,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
			output: outputTokens,
			reasoning: reasoningTokens,
			total: totalTokens,
			modality: usage.modality ?? "text",
		},
	};
};
