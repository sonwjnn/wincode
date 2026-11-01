import {
	type AgentTurnId,
	isSessionToolCallPart,
	type SessionRecord,
	type SessionRecordId,
} from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai";
import type {
	CompactionId,
	SessionId,
	SessionUsageEntryId,
} from "../../../shared/identifiers";
import {
	normalizeProviderModelSelection,
	type ProviderModelSelection,
} from "../../providers/provider-model-selection";

export type SessionStatisticsCost = Readonly<{
	amount: number;
	unit: string;
}>;

/** Stable identity used to avoid counting a durable contribution twice. */
export type SessionUsageContributionIdentity =
	| Readonly<{
			kind: "record";
			recordId: SessionRecordId;
			sessionId: SessionId;
	  }>
	| Readonly<{
			kind: "usage-entry";
			entryId: SessionUsageEntryId;
			sessionId: SessionId;
	  }>
	| Readonly<{
			kind: "compaction";
			compactionId: CompactionId;
			sessionId: SessionId;
	  }>;

export type SessionUsageContribution = Readonly<{
	cost: SessionStatisticsCost | null;
	identity: SessionUsageContributionIdentity;
	model: ProviderModelSelection;
	turnId?: AgentTurnId;
	usage: ModelUsage;
}>;

export type SessionStatisticsAccountingInput = Readonly<{
	actual: readonly SessionUsageContribution[];
	auxiliary: readonly SessionUsageContribution[];
	inherited: readonly SessionUsageContribution[];
}>;

type SessionStatisticsUsageEntry = Readonly<{
	compactionId?: CompactionId;
	costUsd: number | null;
	id: SessionUsageEntryId;
	kind: "cache-warm" | "compaction-summary";
	model: ProviderModelSelection;
	usage: ModelUsage;
}>;

type SessionStatisticsCompaction = Readonly<{
	id: CompactionId;
	summarizationModel: ProviderModelSelection;
	summarizationUsage?: ModelUsage;
}>;

export type SessionStatisticsCostTotal = Readonly<{
	amount: number;
	contributionCount: number;
	model: ProviderModelSelection;
	unit: string;
}>;

export type SessionStatisticsUsageTotals = Readonly<{
	byModel: readonly (Readonly<{
		model: ProviderModelSelection;
	}> &
		SessionStatisticsUsageCategory)[];
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	contributionCount: number;
	costs: readonly SessionStatisticsCostTotal[];
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	unknownCostCount: number;
}>;

export type SessionStatisticsUsageCategory = Readonly<{
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	contributionCount: number;
	costs: readonly SessionStatisticsCostTotal[];
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	unknownCostCount: number;
}>;

export type SessionStatisticsUsage = Readonly<{
	actual: SessionStatisticsUsageTotals;
	auxiliary: SessionStatisticsUsageTotals;
	inherited: SessionStatisticsUsageTotals;
}>;

export type SessionTurnTerminalOutcome = Readonly<
	| { kind: "no-terminal-record" }
	| { kind: "multiple-terminal-records" }
	| {
			finishedAt: number;
			kind: "cancelled" | "completed" | "failed" | "interrupted";
	  }
>;

export type SessionTurnStatistics = Readonly<{
	completedToolCallCount: number;
	recordCount: number;
	terminalOutcome: SessionTurnTerminalOutcome;
	turnId: AgentTurnId;
}>;

export type SessionStatistics = Readonly<{
	completedToolCallCount: number;
	recordCount: number;
	readPoint: string;
	sessionId: SessionId;
	terminalOutcomeCounts: Readonly<{
		cancelled: number;
		completed: number;
		failed: number;
		interrupted: number;
	}>;
	turn?: SessionTurnStatistics;
	usage: SessionStatisticsUsage;
}>;

export type SessionStatisticsOptions = Readonly<{
	readPoint?: string;
	turnId?: AgentTurnId;
}>;

type UsageContributionGroup = Readonly<{
	model: ProviderModelSelection;
	contributions: readonly SessionUsageContribution[];
}>;

const identityKey = (identity: SessionUsageContributionIdentity): string => {
	switch (identity.kind) {
		case "record":
			return JSON.stringify([
				identity.kind,
				identity.sessionId,
				identity.recordId,
			]);
		case "usage-entry":
			return JSON.stringify([
				identity.kind,
				identity.sessionId,
				identity.entryId,
			]);
		case "compaction":
			return JSON.stringify([
				identity.kind,
				identity.sessionId,
				identity.compactionId,
			]);
		default:
			throw new Error("Unknown Session usage contribution identity kind.");
	}
};

const modelKey = (model: ProviderModelSelection): string =>
	JSON.stringify({
		modelId: model.modelId,
		pluginProviderSource: model.pluginProviderSource ?? null,
		providerId: model.providerId,
	});

const sumKnownField = (
	contributions: readonly SessionUsageContribution[],
	field:
		| "cacheReadTokens"
		| "cacheWriteTokens"
		| "reasoningTokens"
		| "totalTokens"
): number | null => {
	if (
		contributions.length === 0 ||
		contributions.some(({ usage }) => usage[field] === undefined)
	) {
		return null;
	}
	return contributions.reduce(
		(total, { usage }) => total + (usage[field] ?? 0),
		0
	);
};

const costTotals = (
	contributions: readonly SessionUsageContribution[]
): SessionStatisticsCostTotal[] => {
	const totals = new Map<string, SessionStatisticsCostTotal>();
	for (const contribution of contributions) {
		const { cost, model } = contribution;
		if (cost === null) {
			continue;
		}
		const key = JSON.stringify([modelKey(model), cost.unit]);
		const previous = totals.get(key);
		totals.set(key, {
			amount: (previous?.amount ?? 0) + cost.amount,
			contributionCount: (previous?.contributionCount ?? 0) + 1,
			model: previous?.model ?? model,
			unit: cost.unit,
		});
	}
	return [...totals.values()].sort((left, right) =>
		JSON.stringify([modelKey(left.model), left.unit]).localeCompare(
			JSON.stringify([modelKey(right.model), right.unit])
		)
	);
};

const totalsFor = (
	contributions: readonly SessionUsageContribution[]
): SessionStatisticsUsageCategory => ({
	cacheReadTokens: sumKnownField(contributions, "cacheReadTokens"),
	cacheWriteTokens: sumKnownField(contributions, "cacheWriteTokens"),
	contributionCount: contributions.length,
	costs: costTotals(contributions),
	inputTokens:
		contributions.length === 0
			? null
			: contributions.reduce(
					(total, { usage }) => total + usage.inputTokens,
					0
				),
	outputTokens:
		contributions.length === 0
			? null
			: contributions.reduce(
					(total, { usage }) => total + usage.outputTokens,
					0
				),
	reasoningTokens: sumKnownField(contributions, "reasoningTokens"),
	totalTokens: sumKnownField(contributions, "totalTokens"),
	unknownCostCount: contributions.filter(({ cost }) => cost === null).length,
});

const usageGroups = (
	contributions: readonly SessionUsageContribution[]
): UsageContributionGroup[] => {
	const groups = new Map<string, UsageContributionGroup>();
	for (const contribution of contributions) {
		const key = modelKey(contribution.model);
		const previous = groups.get(key);
		groups.set(key, {
			model: previous?.model ?? contribution.model,
			contributions: [...(previous?.contributions ?? []), contribution],
		});
	}
	return [...groups.values()].sort((left, right) =>
		modelKey(left.model).localeCompare(modelKey(right.model))
	);
};

const categoryTotals = (
	contributions: readonly SessionUsageContribution[]
): SessionStatisticsUsageTotals => ({
	...totalsFor(contributions),
	byModel: usageGroups(contributions).map(
		({ model, contributions: group }) => ({
			...totalsFor(group),
			model,
		})
	),
});

/** Reduces persisted usage by non-overlapping provenance and stable identity. */
export const reduceSessionUsageContributions = (
	input: SessionStatisticsAccountingInput
): SessionStatisticsUsage => {
	const seen = new Map<string, keyof SessionStatisticsAccountingInput>();
	const unique = {
		actual: [] as SessionUsageContribution[],
		auxiliary: [] as SessionUsageContribution[],
		inherited: [] as SessionUsageContribution[],
	};
	for (const category of ["actual", "inherited", "auxiliary"] as const) {
		for (const contribution of input[category]) {
			const key = identityKey(contribution.identity);
			const previousCategory = seen.get(key);
			if (previousCategory !== undefined) {
				if (previousCategory !== category) {
					throw new Error(
						"A Session usage identity cannot belong to multiple accounting categories."
					);
				}
				continue;
			}
			seen.set(key, category);
			unique[category].push(contribution);
		}
	}
	return {
		actual: categoryTotals(unique.actual),
		auxiliary: categoryTotals(unique.auxiliary),
		inherited: categoryTotals(unique.inherited),
	};
};

const modelSelectionForRecord = (
	record: SessionRecord
): ProviderModelSelection => {
	const selection = normalizeProviderModelSelection({
		modelId: record.model.modelId,
		pluginProviderSource: record.model.pluginProviderSource,
		providerId: record.model.providerId,
	});
	if (selection === null) {
		throw new Error(
			"Session statistics found an invalid record Model identity."
		);
	}
	return selection;
};

const recordToolCallIds = (records: readonly SessionRecord[]): Set<string> =>
	new Set(
		records.flatMap((record) =>
			record.messages.flatMap((message) =>
				message.parts.flatMap((part) =>
					isSessionToolCallPart(part) ? [part.toolCallId] : []
				)
			)
		)
	);

const terminalOutcomeFor = (
	records: readonly SessionRecord[]
): SessionTurnTerminalOutcome => {
	const terminalRecords = records.filter(
		(record) => record.outcome.kind === "assistant"
	);
	if (terminalRecords.length === 0) {
		return { kind: "no-terminal-record" };
	}
	if (terminalRecords.length > 1) {
		return { kind: "multiple-terminal-records" };
	}
	const terminalRecord = terminalRecords[0];
	if (terminalRecord?.outcome.kind !== "assistant") {
		return { kind: "no-terminal-record" };
	}
	return {
		finishedAt: terminalRecord.outcome.terminal.finishedAt,
		kind: terminalRecord.outcome.terminal.kind,
	};
};

const turnStatistics = (
	turnId: AgentTurnId,
	records: readonly SessionRecord[]
): SessionTurnStatistics => ({
	completedToolCallCount: recordToolCallIds(records).size,
	recordCount: records.length,
	terminalOutcome: terminalOutcomeFor(records),
	turnId,
});

/** Builds statistics from the committed records and usage entries at one read point. */
export const buildSessionStatistics = ({
	compactions,
	inheritedUsage = [],
	readPoint,
	records,
	sessionId,
	turnId,
	usageEntries,
}: {
	compactions: readonly SessionStatisticsCompaction[];
	inheritedUsage?: readonly SessionUsageContribution[];
	readPoint: string;
	records: readonly SessionRecord[];
	sessionId: SessionId;
	turnId?: AgentTurnId;
	usageEntries: readonly SessionStatisticsUsageEntry[];
}): SessionStatistics => {
	const selectedRecords =
		turnId === undefined
			? [...records]
			: records.filter((record) => record.turnId === turnId);
	const selectedUsageEntries = turnId === undefined ? [...usageEntries] : [];
	const selectedCompactions = turnId === undefined ? [...compactions] : [];
	const linkedCompactionIds = new Set(
		selectedUsageEntries.flatMap((entry) =>
			entry.kind === "compaction-summary" && entry.compactionId !== undefined
				? [entry.compactionId]
				: []
		)
	);
	const actual: SessionUsageContribution[] = selectedRecords.flatMap(
		(record) => {
			const terminal =
				record.outcome.kind === "assistant"
					? record.outcome.terminal
					: undefined;
			if (terminal?.kind !== "completed" || terminal.usage === undefined) {
				return [];
			}
			return [
				{
					cost: null,
					identity: {
						kind: "record",
						recordId: record.id,
						sessionId,
					},
					model: modelSelectionForRecord(record),
					turnId: record.turnId,
					usage: terminal.usage,
				},
			];
		}
	);
	const auxiliary: SessionUsageContribution[] = selectedUsageEntries.map(
		(entry) => ({
			cost:
				entry.costUsd === null ? null : { amount: entry.costUsd, unit: "USD" },
			identity: {
				entryId: entry.id,
				kind: "usage-entry",
				sessionId,
			},
			model: entry.model,
			usage: entry.usage,
		})
	);
	for (const compaction of selectedCompactions) {
		if (
			compaction.summarizationUsage === undefined ||
			linkedCompactionIds.has(compaction.id)
		) {
			continue;
		}
		auxiliary.push({
			cost: null,
			identity: {
				compactionId: compaction.id,
				kind: "compaction",
				sessionId,
			},
			model: compaction.summarizationModel,
			usage: compaction.summarizationUsage,
		});
	}
	const selectedInherited =
		turnId === undefined
			? [...inheritedUsage]
			: inheritedUsage.filter((contribution) => contribution.turnId === turnId);
	const usage = reduceSessionUsageContributions({
		actual,
		auxiliary,
		inherited: selectedInherited,
	});
	const turn =
		turnId === undefined ? undefined : turnStatistics(turnId, selectedRecords);
	const terminalOutcomeCounts = {
		cancelled: 0,
		completed: 0,
		failed: 0,
		interrupted: 0,
	};
	for (const record of selectedRecords) {
		if (record.outcome.kind === "assistant") {
			terminalOutcomeCounts[record.outcome.terminal.kind] += 1;
		}
	}
	return {
		completedToolCallCount: recordToolCallIds(selectedRecords).size,
		recordCount: selectedRecords.length,
		readPoint,
		sessionId,
		terminalOutcomeCounts,
		...(turn === undefined ? {} : { turn }),
		usage,
	};
};
