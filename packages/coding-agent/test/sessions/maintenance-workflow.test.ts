import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { OperationalFailure } from "@wincode/agent-core";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	createSessionMaintenanceWorkflow,
	type SessionMaintenancePort,
	type SessionMaintenanceSnapshot,
	type SessionMaintenanceTransition,
	type SessionMaintenanceWorkflow,
} from "@/modules/sessions/agent-session/maintenance-workflow";
import type { SessionOverflowContinuationOutcome } from "@/modules/sessions/agent-session/types";
import type {
	CompactionRequestInput as CompactSessionInput,
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

const RECOVERY_EPOCH = Symbol("recovery-epoch");

/** The one Agent Session state a maintenance step reads, as frozen values. */
const snapshotOf = ({
	context = [sourceMessage],
	transcript = [sourceMessage],
	...overrides
}: Partial<SessionMaintenanceSnapshot> = {}): SessionMaintenanceSnapshot => ({
	activeCompaction: undefined,
	context,
	recovery: { attempted: new Set(), epoch: RECOVERY_EPOCH },
	sessionId: sessionId("maintenance-policy"),
	shutdownSignal: new AbortController().signal,
	transcript,
	...overrides,
});

/**
 * Applies one transition the way the Agent Session does, so the fixture's
 * `apply` and `read` stay coupled: a test can observe a command settling
 * mid-await instead of pinning one frozen snapshot for the workflow's life.
 */
const applyTo = (
	state: SessionMaintenanceSnapshot,
	transition: SessionMaintenanceTransition
): SessionMaintenanceSnapshot => {
	switch (transition.kind) {
		case "compaction-started":
			return { ...state, activeCompaction: transition.command };
		case "compaction-phase":
			return state.activeCompaction?.promise === transition.command.promise
				? {
						...state,
						activeCompaction: {
							...transition.command,
							phase: transition.phase,
						},
					}
				: state;
		case "compaction-settled":
			return state.activeCompaction?.promise === transition.command.promise
				? { ...state, activeCompaction: undefined }
				: state;
		case "recovery-begun":
			return {
				...state,
				recovery: {
					...state.recovery,
					attempted: new Set([
						...state.recovery.attempted,
						transition.messageId,
					]),
				},
			};
		case "recovery-released": {
			const attempted = new Set(state.recovery.attempted);
			attempted.delete(transition.messageId);
			return { ...state, recovery: { ...state.recovery, attempted } };
		}
		default:
			return state;
	}
};

/** A workflow whose frozen state a test can advance, the way a peer would. */
type WorkflowFixture = SessionMaintenanceWorkflow & {
	/** Replaces part of the state the next read returns. */
	update: (patch: Partial<SessionMaintenanceSnapshot>) => void;
};

const createWorkflow = (
	compact: SessionMaintenancePort["compaction"]["compact"],
	resolveCompactionSettings: SessionMaintenancePort["effects"]["resolveCompactionSettings"],
	initial: SessionMaintenanceSnapshot = snapshotOf()
): WorkflowFixture => {
	let state = initial;
	const workflow = createSessionMaintenanceWorkflow({
		apply: (transition) => {
			state = applyTo(state, transition);
		},
		compaction: {
			compact,
			getInFlight: () => null,
			needsCompaction: () => false,
		},
		effects: {
			drainQueueInBackground: () => undefined,
			resolveCompactionSettings,
			runTrackedRecovery: (run) => run(),
			waitForExecutionEnd: async () => undefined,
			withTranscriptOverlay: (messages) => messages,
		},
		read: () => state,
		signals: () => ({
			closed: () => false,
			recoveryCurrent: () => true,
		}),
	});
	return Object.assign(workflow, {
		update: (patch: Partial<SessionMaintenanceSnapshot>) => {
			state = { ...state, ...patch };
		},
	});
};

const createRecoveryWorkflow = (
	compact: SessionMaintenancePort["compaction"]["compact"],
	initial: SessionMaintenanceSnapshot = snapshotOf({
		context: toolAttemptMessages,
		transcript: toolAttemptMessages,
		sessionId: sessionId("maintenance-overflow"),
	})
): WorkflowFixture =>
	createWorkflow(
		compact,
		async (model: ProviderModelSelection) =>
			resolveCompactionSettings({
				contextLimit: 100_000,
				model,
				snapshot: configuration,
			}),
		initial
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
	const requests: CompactSessionInput[] = [];
	const workflow = createRecoveryWorkflow(async (input) => {
		requests.push(input);
		return fromPartial<CompactSessionResult>({
			activeMessages: [...input.session.messages],
			entry: fromPartial<SessionCompaction>({
				id: compactionId("entry-late-settlement"),
				trigger: "overflow",
			}),
		});
	});

	const outcome = await workflow.recoverOverflow({
		continueContext: async () => ({ kind: "started" }),
		error: fromPartial<OperationalFailure>({ code: "context-overflow" }),
		originalMessageId: sessionMessageId("attempt-user"),
		resolveTarget: async () => {
			// A steering message settles while the target's settings resolve. It
			// replaces the transcript rather than mutating it, so a recovery that
			// kept the snapshot it opened with would summarize the older history.
			const settled: readonly SessionMessage[] = [
				...toolAttemptMessages,
				fromPartial<SessionMessage>({
					id: sessionMessageId("late-steering"),
					parts: [{ text: "also check the tests", type: "text" }],
					role: "user",
				}),
			];
			workflow.update({ context: settled, transcript: settled });
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

test("a joiner whose owner settles while its settings load is answered with its own entry", async () => {
	const entries: string[] = [];
	const rejectSummary = Promise.withResolvers<never>();
	const workflow = createWorkflow(
		// The first command never finishes until the test cancels it.
		(input) => {
			if (entries.length === 0) {
				entries.push("owner");
				return rejectSummary.promise;
			}
			entries.push("joiner");
			return Promise.resolve(
				fromPartial<CompactSessionResult>({
					activeMessages: [...input.session.messages],
					entry: fromPartial<SessionCompaction>({
						id: compactionId("entry-joiner"),
						trigger: input.trigger,
					}),
				})
			);
		},
		async (model) => {
			if (entries.length > 0) {
				// The owner settles while the joiner is still resolving its settings,
				// so the joiner reads a Session with no compaction in flight.
				workflow.update({ activeCompaction: undefined });
			}
			return resolveCompactionSettings({
				contextLimit: 100_000,
				model,
				snapshot: configuration,
			});
		}
	);

	const owner = workflow.compact({ model: manualModel, trigger: "threshold" });
	owner.catch(() => undefined);
	await Bun.sleep(0);
	const joined = workflow.compact({ model: manualModel, trigger: "threshold" });

	const result = await joined;

	// A caller is never answered with another caller's entry.
	expect(result.entry.id).toBe(compactionId("entry-joiner"));
	expect(entries).toEqual(["owner", "joiner"]);
	rejectSummary.reject(new Error("owner cancelled"));
});
