import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { OperationalFailure } from "@wincode/agent-core";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	createSessionMaintenanceWorkflow,
	type SessionMaintenancePort,
} from "@/modules/sessions/agent-session/maintenance-workflow";
import type { SessionOverflowContinuationOutcome } from "@/modules/sessions/agent-session/types";
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
	providerModelSelectionFixture,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const manualModel = providerModelSelectionFixture("openai/gpt-4.1/2025-04-14");
const automaticModel = providerModelSelectionFixture(
	"anthropic/claude-3-7-sonnet"
);
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
			applyCompactionResult: () => undefined,
			compaction: {
				compact,
				getInFlight: () => null,
				needsCompaction: () => false,
			},
			drainQueueInBackground: () => undefined,
			getActiveCompaction: () => undefined,
			getContext: () => [sourceMessage],
			hasAttemptedRecovery: () => false,
			getSessionState: () => ({
				closed: false,
				id: sessionId("maintenance-policy"),
				shutdownSignal: new AbortController().signal,
			}),
			getTranscript: () => [sourceMessage],
			isRecoveryCurrent: () => true,
			mergeTranscript: (messages: readonly SessionMessage[]) => messages,
			releaseRecoveryAttempt: () => undefined,
			resolveCompactionSettings,
			runTrackedOverflowRecovery: <T>(run: () => Promise<T>) => run(),
			setCompactionError: () => undefined,
			startRecoveryAttempt: () => 0,
			trackCompactionRequest: (request: Promise<CompactSessionResult>) =>
				request,
			transitionCompactionCommand: () => undefined,
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
		trigger: "context-overflow",
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

const toolAttemptMessages: SessionMessage[] = [
	fromPartial<SessionMessage>({
		id: sessionMessageId("older-user"),
		parts: [{ text: "older request", type: "text" }],
		role: "user",
	}),
	fromPartial<SessionMessage>({
		id: sessionMessageId("older-assistant"),
		parts: [{ text: "older answer", type: "text" }],
		role: "assistant",
	}),
	fromPartial<SessionMessage>({
		id: sessionMessageId("attempt-user"),
		parts: [{ text: "run the tool", type: "text" }],
		role: "user",
	}),
	fromPartial<SessionMessage>({
		id: sessionMessageId("step-assistant"),
		parts: [
			{
				input: { command: "pwd" },
				output: { output: "/workspace" },
				state: "output-available",
				toolCallId: toolCallId("call-step"),
				type: "tool-shell",
			},
		],
		role: "assistant",
	}),
	fromPartial<SessionMessage>({
		id: sessionMessageId("failed-assistant"),
		metadata: { terminalOutcome: "failed" },
		parts: [{ text: "The prompt exceeds the context window.", type: "text" }],
		role: "assistant",
	}),
];

const createRecoveryWorkflow = (
	compact: SessionMaintenancePort["compaction"]["compact"],
	overrides: Partial<SessionMaintenancePort> = {}
) =>
	createSessionMaintenanceWorkflow(
		fromPartial<SessionMaintenancePort>({
			applyCompactionResult: () => undefined,
			compaction: {
				compact,
				getInFlight: () => null,
				needsCompaction: () => false,
			},
			drainQueueInBackground: () => undefined,
			getActiveCompaction: () => undefined,
			getContext: () => toolAttemptMessages,
			hasAttemptedRecovery: () => false,
			getSessionState: () => ({
				closed: false,
				id: sessionId("maintenance-overflow"),
				shutdownSignal: new AbortController().signal,
			}),
			getTranscript: () => toolAttemptMessages,
			isRecoveryCurrent: () => true,
			mergeTranscript: (messages: readonly SessionMessage[]) => messages,
			releaseRecoveryAttempt: () => undefined,
			resolveCompactionSettings: async (model: ProviderModelSelection) =>
				resolveCompactionSettings({
					contextLimit: 100_000,
					model,
					snapshot: configuration,
				}),
			runTrackedOverflowRecovery: <T>(run: () => Promise<T>) => run(),
			setCompactionError: () => undefined,
			startRecoveryAttempt: () => 0,
			trackCompactionRequest: (request: Promise<CompactSessionResult>) =>
				request,
			transitionCompactionCommand: () => undefined,
			waitForExecutionEnd: async () => undefined,
			...overrides,
		})
	);

test("overflow recovery after completed tools continues the durable context", async () => {
	const requests: CompactSessionInput[] = [];
	const continuations: string[] = [];
	const workflow = createRecoveryWorkflow(async (input) => {
		requests.push(input);
		return fromPartial<CompactSessionResult>({
			activeMessages: [...input.session.messages],
			entry: fromPartial<SessionCompaction>({
				id: compactionId("entry-overflow"),
				trigger: "overflow",
			}),
		});
	});

	const outcome = await workflow.recoverOverflow({
		continueContext: async ({ originalMessageId }) => {
			continuations.push(originalMessageId);
			return { kind: "started" };
		},
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-tool-turn"),
		trigger: "context-overflow",
	});

	expect(outcome.kind).toBe("recovered");
	// The completed Tool Call and its settled step stay out of the summary.
	expect(requests[0]?.protectedMessageIds?.map((id) => id as string)).toEqual([
		"step-assistant",
	]);
	expect(
		requests[0]?.session.messages.map(({ id }) => id as string)
	).not.toContain("failed-assistant");
	// The continuation resumes the existing context; it does not answer the prompt again.
	expect(continuations).toEqual(["attempt-user"]);
});

test("an unshortenable continuation fails closed instead of replaying tools", async () => {
	const continuations: string[] = [];
	const workflow = createRecoveryWorkflow(async () => {
		throw fromPartial<Error & { code: string; name: string }>({
			code: "history-too-short",
			message:
				"There is no older durable step history that can be compacted while preserving the current continuation.",
			name: "SessionCompactionError",
		});
	});

	const outcome = await workflow.recoverOverflow({
		continueContext: async ({ originalMessageId }) => {
			continuations.push(originalMessageId);
			return { kind: "started" };
		},
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-unshortenable"),
		trigger: "context-overflow",
	});

	expect(outcome.kind).toBe("failed");
	expect(continuations).toEqual([]);
});

test("overflow recovery guidance distinguishes compaction failure from saved-context continuation failure", async () => {
	const continuations: string[] = [];
	const compactionFailure = await createRecoveryWorkflow(async () => {
		throw new Error("summary generation was refused");
	}).recoverOverflow({
		continueContext: async ({ originalMessageId }) => {
			continuations.push(originalMessageId);
			return { kind: "started" };
		},
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-compaction-guidance"),
		trigger: "context-overflow",
	});

	expect(compactionFailure.kind).toBe("failed");
	if (compactionFailure.kind !== "failed") {
		throw new Error("The failed compaction recovery unexpectedly succeeded.");
	}
	expect(compactionFailure.error).toMatchObject({ code: "compaction-failed" });
	expect(compactionFailure.error.message).toContain(
		"No compaction was committed"
	);
	expect(compactionFailure.error.message).toContain(
		"No new session was created"
	);
	expect(compactionFailure.error.message).toContain(
		"completed tool effects were not replayed"
	);
	expect(compactionFailure.error.message).toContain(
		"Review the existing Session"
	);
	expect(continuations).toEqual([]);

	let compactionCount = 0;
	const continuationRefusal = await createRecoveryWorkflow(async () => {
		compactionCount += 1;
		return fromPartial<CompactSessionResult>({
			activeMessages: toolAttemptMessages,
			entry: fromPartial<SessionCompaction>({
				id: compactionId("entry-refused-continuation"),
				trigger: "overflow",
			}),
		});
	}).recoverOverflow({
		continueContext: async ({ originalMessageId }) => {
			continuations.push(originalMessageId);
			return { kind: "refused", reason: "another Session command is active" };
		},
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-continuation-guidance"),
		trigger: "context-overflow",
	});

	expect(continuationRefusal.kind).toBe("failed");
	if (continuationRefusal.kind !== "failed") {
		throw new Error("The refused continuation unexpectedly succeeded.");
	}
	expect(continuationRefusal.error).toMatchObject({
		code: "continuation-refused",
	});
	expect(continuationRefusal.error.message).toContain(
		"saved a compacted Session Context"
	);
	expect(continuationRefusal.error.message).toContain(
		"No new session was created"
	);
	expect(continuationRefusal.error.message).toContain(
		"completed tool effects were not replayed"
	);
	expect(continuationRefusal.error.message).toContain(
		"do not resubmit the original request"
	);
	expect(compactionCount).toBe(1);
	expect(continuations).toEqual([sessionMessageId("attempt-user")]);
});

test("post-commit continuation turn failure reports the saved-context recovery state", async () => {
	const outcome = await createRecoveryWorkflow(async () =>
		fromPartial<CompactSessionResult>({
			activeMessages: toolAttemptMessages,
			entry: fromPartial<SessionCompaction>({
				id: compactionId("entry-failed-continuation"),
				trigger: "overflow",
			}),
		})
	).recoverOverflow({
		continueContext: async () =>
			fromPartial<SessionOverflowContinuationOutcome>({ kind: "failed" }),
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => ({ model: automaticModel }),
		turnId: agentTurnId("overflow-continuation-failed"),
		trigger: "context-overflow",
	});

	expect(outcome.kind).toBe("failed");
	if (outcome.kind !== "failed") {
		throw new Error("The failed continuation unexpectedly recovered.");
	}
	expect(outcome.error).toMatchObject({ code: "continuation-failed" });
	expect(outcome.error.message).toContain("saved a compacted Session Context");
	expect(outcome.error.message).toContain("No new session was created");
	expect(outcome.error.message).toContain(
		"completed tool effects were not replayed"
	);
	expect(outcome.error.message).toContain(
		"do not resubmit the original request"
	);
});

test("recovery compacts work settled while its target settings were loading", async () => {
	const messages: SessionMessage[] = [...toolAttemptMessages];
	const requests: CompactSessionInput[] = [];
	const workflow = createRecoveryWorkflow(
		async (input) => {
			requests.push(input);
			return fromPartial<CompactSessionResult>({
				activeMessages: [...input.session.messages],
				entry: fromPartial<SessionCompaction>({
					id: compactionId("entry-late-settlement"),
					trigger: "overflow",
				}),
			});
		},
		{
			getContext: () => messages,
			getTranscript: () => messages,
		}
	);

	const outcome = await workflow.recoverOverflow({
		continueContext: async () => ({ kind: "started" }),
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => {
			// A steering message settles while the target's settings resolve.
			messages.push(
				fromPartial<SessionMessage>({
					id: sessionMessageId("late-steering"),
					parts: [{ text: "also check the tests", type: "text" }],
					role: "user",
				})
			);
			return { model: automaticModel };
		},
		turnId: agentTurnId("overflow-late-settlement"),
		trigger: "context-overflow",
	});

	expect(outcome.kind).toBe("recovered");
	expect(requests[0]?.session.messages.map(({ id }) => id as string)).toContain(
		"late-steering"
	);
});
