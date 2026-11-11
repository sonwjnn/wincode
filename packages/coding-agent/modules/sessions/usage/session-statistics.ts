import {
	type AgentTurnId,
	isSessionToolCallPart,
	type SessionRecord,
	type SessionRecordId,
} from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
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
	compactionId?: CompactionId;
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
	selectedPath?: readonly SessionUsageContribution[];
}>;

export type SessionStatisticsHistoryPath = Readonly<{
	compactionIds: ReadonlySet<string>;
	recordIds: ReadonlySet<string>;
}>;

type SessionStatisticsUsageEntry = Readonly<{
	compactionId?: CompactionId;
	costUsd: number | null;
	id: SessionUsageEntryId;
	kind: "cache-warm" | "compaction-summary";
	model: ProviderModelSelection;
	usage: ModelUsage;
}>;

export type SessionStatisticsCompaction = Readonly<{
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
	selectedPath: SessionStatisticsUsageTotals;
	contributions: Readonly<{
		actual: readonly SessionUsageContribution[];
		auxiliary: readonly SessionUsageContribution[];
		inherited: readonly SessionUsageContribution[];
		selectedPath: readonly SessionUsageContribution[];
	}>;
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

export type SessionStatisticsRecord = Pick<
	SessionRecord,
	"id" | "turnId" | "model" | "outcome"
> &
	Partial<Pick<SessionRecord, "messages">>;

export type SessionStatisticsRecordSummary = Readonly<{
	completedToolCallCount: number;
	recordCount: number;
	terminalOutcomeCounts: Readonly<{
		cancelled: number;
		completed: number;
		failed: number;
		interrupted: number;
	}>;
	turn?: SessionTurnStatistics;
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
	const selectedPath: SessionUsageContribution[] = [];
	const selectedPathIdentities = new Set<string>();
	for (const contribution of input.selectedPath ?? []) {
		const key = identityKey(contribution.identity);
		if (!selectedPathIdentities.has(key)) {
			selectedPathIdentities.add(key);
			selectedPath.push(contribution);
		}
	}
	return {
		actual: categoryTotals(unique.actual),
		auxiliary: categoryTotals(unique.auxiliary),
		contributions: {
			actual: unique.actual,
			auxiliary: unique.auxiliary,
			inherited: unique.inherited,
			selectedPath,
		},
		inherited: categoryTotals(unique.inherited),
		selectedPath: categoryTotals(selectedPath),
	};
};

const modelSelectionForRecord = (
	record: Pick<SessionRecord, "model">
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

const recordToolCallIds = (
	records: readonly SessionStatisticsRecord[]
): Set<string> =>
	new Set(
		records.flatMap((record) =>
			(record.messages ?? []).flatMap((message) =>
				message.parts.flatMap((part) =>
					isSessionToolCallPart(part) ? [part.toolCallId] : []
				)
			)
		)
	);

const terminalOutcomeFor = (
	records: readonly SessionStatisticsRecord[]
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
	records: readonly SessionStatisticsRecord[]
): SessionTurnStatistics => ({
	completedToolCallCount: recordToolCallIds(records).size,
	recordCount: records.length,
	terminalOutcome: terminalOutcomeFor(records),
	turnId,
});

/** Combines per-Session statistics without counting inherited usage twice. */
export const aggregateSessionStatisticsUsage = (
	statistics: readonly SessionStatistics[]
): SessionStatisticsUsage => {
	const actual = statistics.flatMap(({ usage }) => usage.contributions.actual);
	const inherited = statistics.flatMap(
		({ usage }) => usage.contributions.inherited
	);
	const auxiliary = statistics.flatMap(
		({ usage }) => usage.contributions.auxiliary
	);
	const selectedPath = statistics.flatMap(
		({ usage }) => usage.contributions.selectedPath
	);
	const actualIdentities = new Set(
		actual.map(({ identity }) => identityKey(identity))
	);
	const auxiliaryWithoutActual = auxiliary.filter(
		({ identity }) => !actualIdentities.has(identityKey(identity))
	);
	const auxiliaryIdentities = new Set(
		auxiliaryWithoutActual.map(({ identity }) => identityKey(identity))
	);
	const inheritedWithoutAccounted = inherited.filter(
		({ identity }) =>
			!(
				actualIdentities.has(identityKey(identity)) ||
				auxiliaryIdentities.has(identityKey(identity))
			)
	);
	return reduceSessionUsageContributions({
		actual,
		auxiliary: auxiliaryWithoutActual,
		inherited: inheritedWithoutAccounted,
		selectedPath,
	});
};

const actualUsageContributions = (
	records: readonly SessionStatisticsRecord[],
	sessionId: SessionId,
	inheritedRecordIds: ReadonlySet<string>
): SessionUsageContribution[] =>
	records.flatMap((record) => {
		if (inheritedRecordIds.has(record.id)) {
			return [];
		}
		const terminal =
			record.outcome.kind === "assistant" ? record.outcome.terminal : undefined;
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
	});

const auxiliaryUsageContributions = (
	usageEntries: readonly SessionStatisticsUsageEntry[],
	sessionId: SessionId
): SessionUsageContribution[] =>
	usageEntries.map((entry) => ({
		...omitUndefined({ compactionId: entry.compactionId }),
		cost:
			entry.costUsd === null ? null : { amount: entry.costUsd, unit: "USD" },
		identity: {
			entryId: entry.id,
			kind: "usage-entry",
			sessionId,
		},
		model: entry.model,
		usage: entry.usage,
	}));

const compactionUsageContributions = (
	compactions: readonly SessionStatisticsCompaction[],
	linkedCompactionIds: ReadonlySet<CompactionId>,
	inheritedCompactionIds: ReadonlySet<string>,
	sessionId: SessionId
): SessionUsageContribution[] =>
	compactions.flatMap((compaction) => {
		if (
			compaction.summarizationUsage === undefined ||
			linkedCompactionIds.has(compaction.id) ||
			inheritedCompactionIds.has(compaction.id)
		) {
			return [];
		}
		return [
			{
				compactionId: compaction.id,
				cost: null,
				identity: {
					compactionId: compaction.id,
					kind: "compaction",
					sessionId,
				},
				model: compaction.summarizationModel,
				usage: compaction.summarizationUsage,
			},
		];
	});

const terminalOutcomeCountsFor = (
	records: readonly SessionStatisticsRecord[]
): SessionStatisticsRecordSummary["terminalOutcomeCounts"] => {
	const counts = { cancelled: 0, completed: 0, failed: 0, interrupted: 0 };
	for (const record of records) {
		if (record.outcome.kind === "assistant") {
			counts[record.outcome.terminal.kind] += 1;
		}
	}
	return counts;
};

/** Builds statistics from the committed records and usage entries at one read point. */
export const buildSessionStatistics = ({
	compactions,
	inheritedUsage = [],
	readPoint,
	records,
	sessionId,
	summary,
	turnId,
	usageEntries,
	inheritedRecordIds = new Set<string>(),
	inheritedCompactionIds = new Set<string>(),
	selectedPath,
}: {
	compactions: readonly SessionStatisticsCompaction[];
	inheritedUsage?: readonly SessionUsageContribution[];
	inheritedRecordIds?: ReadonlySet<string>;
	inheritedCompactionIds?: ReadonlySet<string>;
	readPoint: string;
	records: readonly SessionStatisticsRecord[];
	selectedPath?: SessionStatisticsHistoryPath;
	sessionId: SessionId;
	summary?: SessionStatisticsRecordSummary;
	turnId?: AgentTurnId;
	usageEntries: readonly SessionStatisticsUsageEntry[];
}): SessionStatistics => {
	const selectedRecords =
		turnId === undefined
			? records
			: records.filter((record) => record.turnId === turnId);
	const selectedUsageEntries = turnId === undefined ? usageEntries : [];
	const selectedCompactions = turnId === undefined ? compactions : [];
	const linkedCompactionIds = new Set(
		selectedUsageEntries.flatMap((entry) =>
			entry.kind === "compaction-summary" && entry.compactionId !== undefined
				? [entry.compactionId]
				: []
		)
	);
	const actual = actualUsageContributions(
		selectedRecords,
		sessionId,
		inheritedRecordIds
	);
	const auxiliary = [
		...auxiliaryUsageContributions(selectedUsageEntries, sessionId),
		...compactionUsageContributions(
			selectedCompactions,
			linkedCompactionIds,
			inheritedCompactionIds,
			sessionId
		),
	];
	const pathRecordIds =
		selectedPath?.recordIds ?? new Set(records.map(({ id }) => id));
	const pathCompactionIds =
		selectedPath?.compactionIds ??
		new Set(compactions.map(({ id }) => String(id)));
	const selectedPathRecords = selectedRecords.filter(({ id }) =>
		pathRecordIds.has(id)
	);
	const selectedPathCompactions = selectedCompactions.filter(({ id }) =>
		pathCompactionIds.has(String(id))
	);
	const selectedPathTurnIds = new Set(
		selectedPathRecords.map(({ turnId: selectedTurnId }) => selectedTurnId)
	);
	const selectedPathUsageEntries = selectedUsageEntries.filter(
		({ compactionId, kind }) =>
			kind === "compaction-summary" &&
			compactionId !== undefined &&
			pathCompactionIds.has(String(compactionId))
	);
	const selectedPathLinkedCompactionIds = new Set(
		selectedPathUsageEntries.flatMap(({ compactionId }) =>
			compactionId === undefined ? [] : [compactionId]
		)
	);
	const selectedPathActual = actualUsageContributions(
		selectedPathRecords,
		sessionId,
		inheritedRecordIds
	);
	const selectedPathAuxiliary = [
		...auxiliaryUsageContributions(selectedPathUsageEntries, sessionId),
		...compactionUsageContributions(
			selectedPathCompactions,
			selectedPathLinkedCompactionIds,
			inheritedCompactionIds,
			sessionId
		),
	];
	const selectedInherited =
		turnId === undefined
			? inheritedUsage
			: inheritedUsage.filter((contribution) => contribution.turnId === turnId);
	const selectedPathInherited = selectedInherited.filter((contribution) => {
		if (contribution.turnId !== undefined) {
			return selectedPathTurnIds.has(contribution.turnId);
		}
		return (
			contribution.compactionId !== undefined &&
			pathCompactionIds.has(String(contribution.compactionId))
		);
	});
	const selectedPathUsage = reduceSessionUsageContributions({
		actual: selectedPathActual,
		auxiliary: selectedPathAuxiliary,
		inherited: selectedPathInherited,
	}).contributions;
	const usage = reduceSessionUsageContributions({
		actual,
		auxiliary,
		inherited: selectedInherited,
		selectedPath: [
			...selectedPathUsage.actual,
			...selectedPathUsage.auxiliary,
			...selectedPathUsage.inherited,
		],
	});
	let turn: SessionTurnStatistics | undefined;
	if (turnId !== undefined) {
		turn = summary?.turn ?? turnStatistics(turnId, selectedRecords);
	}
	const terminalOutcomeCounts =
		summary?.terminalOutcomeCounts ?? terminalOutcomeCountsFor(selectedRecords);
	return {
		completedToolCallCount:
			summary?.completedToolCallCount ??
			recordToolCallIds(selectedRecords).size,
		recordCount: summary?.recordCount ?? selectedRecords.length,
		readPoint,
		sessionId,
		terminalOutcomeCounts,
		...(turn === undefined ? {} : { turn }),
		usage,
	};
};
