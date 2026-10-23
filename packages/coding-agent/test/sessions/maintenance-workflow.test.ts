import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { OperationalFailure } from "@wincode/agent-core";
import {
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import {
	createSessionMaintenanceWorkflow,
	type SessionMaintenancePort,
} from "@/modules/sessions/agent-session/maintenance-workflow";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "@/modules/sessions/compaction";
import {
	type ResolvedCompactionSettings,
	resolveCompactionSettings,
} from "@/modules/sessions/compaction/config";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type { SessionMessage } from "@/modules/sessions/message";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import {
	agentTurnId,
	compactionId,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";

const selectedModel = (identity: string): ProviderModelSelection => {
	const model = parseProviderModelSelection(identity);
	if (model === null) {
		throw new Error(`Invalid Provider Model fixture: ${identity}`);
	}
	return model;
};

const manualModel = selectedModel("openai/gpt-4.1/2025-04-14");
const automaticModel = selectedModel("anthropic/claude-3-7-sonnet");
const sourceMessage = fromPartial<SessionMessage>({
	id: sessionMessageId("overflow-source"),
	parts: [{ text: "original request", type: "text" }],
	role: "user",
});

const configuration: ConfigSnapshot = {
	diagnostics: [],
	document: {
		compaction: {
			modelOverrides: {
				"openai/gpt-4.1/2025-04-14": {
					keepRecentTokens: 3000,
					reserveTokens: 4000,
				},
				"anthropic/claude-3-7-sonnet": {
					keepRecentTokens: 8000,
					reserveTokens: 9000,
				},
			},
		},
	},
	sourceFor: () => undefined,
	sources: [],
};

const createWorkflow = (
	compact: SessionMaintenancePort["compaction"]["compact"],
	resolveCompactionSettings: SessionMaintenancePort["resolveCompactionSettings"]
) =>
	createSessionMaintenanceWorkflow(
		fromPartial<SessionMaintenancePort>({
			addCompactionRequest: () => undefined,
			addRecoveryAttempt: () => undefined,
			hasAttemptedRecovery: () => false,
			addRecoveryRun: () => undefined,
			applyContext: () => undefined,
			compaction: {
				compact,
				getInFlight: () => null,
				needsCompaction: () => false,
			},
			drainQueuedSubmissions: async () => undefined,
			finishCompactionCommand: () => undefined,
			getActiveCompaction: () => undefined,
			getContext: () => [sourceMessage],
			getRecoveryGeneration: () => 0,
			getTranscript: () => [sourceMessage],
			isClosed: () => false,
			mergeTranscript: (messages: readonly SessionMessage[]) => messages,
			recordCompaction: () => undefined,
			removeCompactionRequest: () => undefined,
			removeRecoveryAttempt: () => undefined,
			removeRecoveryRun: () => undefined,
			requestOverheadTokens: () => 256,
			resolveCompactionSettings,
			setActiveCompaction: () => undefined,
			setCompactionError: () => undefined,
			setCompactionPhase: () => undefined,
			shutdownSignal: new AbortController().signal,
			sessionId: sessionId("maintenance-policy"),
			trackBackgroundTask: () => undefined,
			waitForExecutionEnd: async () => undefined,
		})
	);

test("manual, threshold, and overflow compaction use the selected model policy", async () => {
	const requests: CompactSessionInput[] = [];
	const settingsFor = async (
		model: ProviderModelSelection
	): Promise<ResolvedCompactionSettings> =>
		resolveCompactionSettings({
			contextLimit: 100_000,
			model,
			snapshot: configuration,
		});
	const workflow = createWorkflow(async (input) => {
		requests.push(input);
		return fromPartial<CompactSessionResult>({
			activeMessages: [...input.session.messages],
			entry: fromPartial<SessionCompaction>({
				id: compactionId(`entry-${input.trigger}`),
				trigger: input.trigger,
			}),
		});
	}, settingsFor);

	await workflow.compact({ model: manualModel, trigger: "manual" });
	await workflow.compact({ model: automaticModel, trigger: "threshold" });
	const recovery = await workflow.recoverOverflow({
		continueContext: async () => ({ kind: "started" }),
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sourceMessage.id,
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-turn"),
	});

	expect(recovery.kind).toBe("recovered");
	expect(
		requests.map(({ model, settings, trigger }) => ({
			keepRecentTokens: settings.keepRecentTokens,
			model: `${model.providerId}/${model.modelId}`,
			reserveTokens: settings.reserveTokens,
			trigger,
		}))
	).toEqual([
		{
			keepRecentTokens: 3000,
			model: "openai/gpt-4.1/2025-04-14",
			reserveTokens: 4000,
			trigger: "manual",
		},
		{
			keepRecentTokens: 8000,
			model: "anthropic/claude-3-7-sonnet",
			reserveTokens: 9000,
			trigger: "threshold",
		},
		{
			keepRecentTokens: 8000,
			model: "anthropic/claude-3-7-sonnet",
			reserveTokens: 9000,
			trigger: "overflow",
		},
	]);
});

test("keeps a started compaction's selected model policy stable", async () => {
	let reserveTokens = 6000;
	const identity = `${manualModel.providerId}/${manualModel.modelId}`;
	const started = Promise.withResolvers<CompactSessionInput>();
	const release = Promise.withResolvers<void>();
	const requests: CompactSessionInput[] = [];
	const workflow = createWorkflow(
		async (input) => {
			requests.push(input);
			if (requests.length === 1) {
				started.resolve(input);
				await release.promise;
			}
			return fromPartial<CompactSessionResult>({
				activeMessages: [...input.session.messages],
				entry: fromPartial<SessionCompaction>({
					id: compactionId(`captured-${requests.length}`),
					trigger: input.trigger,
				}),
			});
		},
		async (model) =>
			resolveCompactionSettings({
				contextLimit: 100_000,
				model,
				snapshot: {
					diagnostics: [],
					document: {
						compaction: {
							modelOverrides: { [identity]: { reserveTokens } },
						},
					},
					sourceFor: () => undefined,
					sources: [],
				},
			})
	);

	const inFlight = workflow.compact({ model: manualModel, trigger: "manual" });
	const capturedRequest = await started.promise;
	reserveTokens = 12_000;
	release.resolve();
	await inFlight;
	await workflow.compact({ model: manualModel, trigger: "manual" });

	expect(capturedRequest.settings.reserveTokens).toBe(6000);
	expect(requests.map(({ settings }) => settings.reserveTokens)).toEqual([
		6000, 12_000,
	]);
});
