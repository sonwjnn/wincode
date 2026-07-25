import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingMessageUsage,
	calculateUsageCostUsd,
	getContextTokens,
} from "@wincode/ai";
import {
	type ModelPricingEntry,
	type ModelPricingTable,
	resolveModelPricing,
} from "@/modules/model-pricing";

export type SessionUsageSummary = {
	/** `null` when no pricing table has an entry for the current model. */
	contextLimit: number | null;
	/** `null` when `contextLimit` is unknown. */
	contextPercent: number | null;
	contextTokens: number;
	costUsd: number | null;
};

const clampPercent = (percent: number): number =>
	Math.max(0, Math.min(100, Math.round(percent)));

const costForMessage = (
	message: CodingAgentUIMessage,
	resolve: (selection: ChatModelSelection) => ModelPricingEntry | null
): number | null => {
	const usage = message.metadata?.usage;
	if (!usage) {
		return null;
	}
	const modelSelection = message.metadata?.model;
	const pricing = modelSelection ? resolve(modelSelection) : null;
	return calculateUsageCostUsd(pricing?.cost, usage);
};

/**
 * Aggregate the current context usage and cumulative cost for a session.
 * Returns `null` when no assistant turn has produced usage yet, so the footer
 * stays hidden on fresh sessions.
 */
export const summarizeSessionUsage = (
	messages: readonly CodingAgentUIMessage[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable
): SessionUsageSummary | null => {
	const resolve = (selection: ChatModelSelection) =>
		resolveModelPricing(table, selection);

	let totalCost = 0;
	let costKnown = false;
	let lastUsage: CodingMessageUsage | null = null;
	let lastPricing: ModelPricingEntry | null = null;
	let lastSelection: ChatModelSelection | null = null;

	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		const usage = message.metadata?.usage;
		if (!usage) {
			continue;
		}
		lastUsage = usage;
		lastSelection = message.metadata?.model ?? null;
		lastPricing = lastSelection ? resolve(lastSelection) : null;
		const perMessage = costForMessage(message, resolve);
		if (perMessage !== null) {
			totalCost += perMessage;
			costKnown = true;
		}
	}

	if (!lastUsage) {
		return null;
	}

	const selection = lastSelection ?? fallbackModel;
	const pricing = lastPricing ?? resolve(selection) ?? resolve(fallbackModel);
	const contextLimit = pricing?.contextLimit ?? null;
	const contextTokens = getContextTokens(lastUsage);
	const contextPercent =
		contextLimit !== null && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	// Independent of whether the *last* turn happens to have known pricing —
	// a session that ends on an unpriced (e.g. OAuth-only) model must not
	// lose the cost it already accumulated from earlier, priced turns.
	const costUsd = costKnown ? totalCost : null;

	return {
		contextLimit,
		contextPercent,
		contextTokens,
		costUsd,
	};
};
