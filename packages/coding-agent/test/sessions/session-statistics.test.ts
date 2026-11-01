import { expect, test } from "bun:test";
import type { SessionRecordId } from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import type {
	SessionStatisticsAccountingInput,
	SessionUsageContribution,
} from "@/modules/sessions/usage/session-statistics";
import {
	buildSessionStatistics,
	reduceSessionUsageContributions,
} from "@/modules/sessions/usage/session-statistics";
import type {
	CompactionId,
	SessionId,
	SessionUsageEntryId,
} from "@/shared/identifiers";

const session = (value: string): SessionId => value as SessionId;
const recordId = (value: string): SessionRecordId => value as SessionRecordId;
const usageEntryId = (value: string): SessionUsageEntryId =>
	value as SessionUsageEntryId;
const sourceModel: ProviderModelSelection = {
	modelId: "historical-model" as ProviderModelSelection["modelId"],
	providerId: "provider-old",
};
const currentModel: ProviderModelSelection = {
	modelId: "current-model" as ProviderModelSelection["modelId"],
	providerId: "provider-new",
};
const usage = (inputTokens: number, outputTokens: number): ModelUsage => ({
	inputTokens,
	outputTokens,
});

test("Session statistics keep inherited spend out of actual and count auxiliary identities once", () => {
	const forkSession = session("statistics-fork");
	const actual: SessionUsageContribution = {
		identity: {
			kind: "record",
			recordId: recordId("actual-turn-record"),
			sessionId: forkSession,
		},
		model: currentModel,
		usage: usage(100, 20),
		cost: null,
	};
	const inherited: SessionUsageContribution = {
		identity: {
			kind: "record",
			recordId: recordId("inherited-prefix-record"),
			sessionId: session("source-session"),
		},
		model: sourceModel,
		usage: usage(900, 80),
		cost: { amount: 0.12, unit: "USD" },
	};
	const auxiliary: SessionUsageContribution = {
		identity: {
			entryId: usageEntryId("cache-warm-entry"),
			kind: "usage-entry",
			sessionId: forkSession,
		},
		model: currentModel,
		usage: usage(40, 0),
		cost: { amount: 0.04, unit: "USD" },
	};
	const input: SessionStatisticsAccountingInput = {
		actual: [actual],
		inherited: [inherited],
		auxiliary: [auxiliary, auxiliary],
	};

	const statistics = reduceSessionUsageContributions(input);

	expect(statistics.actual).toMatchObject({
		contributionCount: 1,
		inputTokens: 100,
		outputTokens: 20,
		costs: [],
		unknownCostCount: 1,
		byModel: [{ model: currentModel, inputTokens: 100, outputTokens: 20 }],
	});
	expect(statistics.inherited).toMatchObject({
		contributionCount: 1,
		inputTokens: 900,
		outputTokens: 80,
		costs: [{ amount: 0.12, unit: "USD" }],
		byModel: [{ model: sourceModel }],
	});
	expect(statistics.auxiliary).toMatchObject({
		contributionCount: 1,
		inputTokens: 40,
		outputTokens: 0,
		costs: [{ amount: 0.04, unit: "USD" }],
	});
});

test("compaction summary usage and its linked auxiliary entry count once at the read point", () => {
	const sessionIdValue = session("statistics-compaction-session");
	const compactionIdValue = "statistics-compaction" as CompactionId;
	const compactionUsage = usage(80, 12);
	const compaction: SessionCompaction = {
		completedAt: new Date("2026-01-01T00:00:01.000Z"),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		estimatedTokensAfter: 20,
		firstKeptUiMessageId:
			"first-kept-message" as SessionCompaction["firstKeptUiMessageId"],
		id: compactionIdValue,
		sessionId: sessionIdValue,
		sequence: 1,
		summarizationModel: sourceModel,
		summarizationUsage: compactionUsage,
		summary: {
			coveredMessageIds: [],
			formatVersion: 1,
			text: "Compacted history",
		},
		throughMessageUiId:
			"covered-message" as SessionCompaction["throughMessageUiId"],
		tokensBefore: 100,
		trigger: "manual",
	};
	const entry: SessionUsageEntry = {
		compactionId: compactionIdValue,
		costUsd: 0.07,
		createdAt: compaction.createdAt,
		id: usageEntryId("statistics-compaction-usage"),
		kind: "compaction-summary",
		model: sourceModel,
		sessionId: sessionIdValue,
		usage: compactionUsage,
	};

	const statistics = buildSessionStatistics({
		compactions: [compaction],
		readPoint: "captured-prefix",
		records: [],
		sessionId: sessionIdValue,
		usageEntries: [entry, entry],
	});

	expect(statistics.usage.auxiliary).toMatchObject({
		contributionCount: 1,
		costs: [{ amount: 0.07, unit: "USD", contributionCount: 1 }],
		inputTokens: 80,
		outputTokens: 12,
		unknownCostCount: 0,
	});
});

test("Session statistics keep provider models distinct when currencies match", () => {
	const sameProviderDifferentModel: SessionUsageContribution = {
		identity: {
			entryId: usageEntryId("separate-unit-entry"),
			kind: "usage-entry",
			sessionId: session("separate-unit-session"),
		},
		model: sourceModel,
		usage: usage(4, 1),
		cost: { amount: 7, unit: "USD" },
	};
	const currentModelUsage: SessionUsageContribution = {
		identity: {
			entryId: usageEntryId("separate-currency-entry"),
			kind: "usage-entry",
			sessionId: session("separate-unit-session"),
		},
		model: currentModel,
		usage: usage(10, 2),
		cost: { amount: 0.5, unit: "USD" },
	};

	const statistics = reduceSessionUsageContributions({
		actual: [],
		auxiliary: [sameProviderDifferentModel, currentModelUsage],
		inherited: [],
	});

	expect(statistics.auxiliary).toMatchObject({
		byModel: [
			{ model: currentModel, inputTokens: 10 },
			{ model: sourceModel, inputTokens: 4 },
		],
		costs: [
			{ amount: 0.5, model: currentModel, unit: "USD" },
			{ amount: 7, model: sourceModel, unit: "USD" },
		],
	});
});
