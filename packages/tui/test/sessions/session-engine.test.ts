import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnId,
	createOperationalFailure,
	type SessionMessageId,
	type SessionRecord,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import { createSessionEngine } from "@/modules/sessions/engine/session-engine";
import type {
	SessionEngine,
	SessionEnginePorts,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryTarget,
	SessionOverflowReplayOutcome,
	SessionSkillCatalog,
} from "@/modules/sessions/engine/types";
import type { SessionViewState } from "@/modules/sessions/hooks/runtime-turn";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type {
	SessionSendInput,
	SessionSubmissionComposition,
} from "@/modules/sessions/session-operation";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { createHangingSummary } from "../support/hanging-summary";
import {
	agentId,
	agentTurnId,
	attachmentId,
	compactionId,
	modelId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const message = (id: string, text = id): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text, type: "text" }],
		role: "user",
	});

const compactionHistory = (): SessionMessage[] => [
	message("u1", "first request"),
	message("a1", "first answer"),
	message("u2", "current request"),
	message("a2", "current answer"),
];

const createCompactionModule = (summaryGenerator: SummaryGenerator) =>
	createSessionCompaction({
		estimateTokens: (messages) => messages.length,
		generateId: () => compactionId("entry-compacted"),
		store: {
			appendCompaction: async (input: AppendSessionCompactionInput) => ({
				...input,
				completedAt: new Date("2026-09-01T00:00:00.000Z"),
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
				id: input.id ?? compactionId("entry-compacted"),
				sequence: 1,
			}),
			getLatestCompaction: async () => null,
		},
		summaryGenerator,
	});

/** The ports one engine test runs against, unless it overrides them. */
const createPorts = ({
	compaction,
	...overrides
}: Partial<SessionEnginePorts> & {
	compaction: SessionEnginePorts["compaction"];
}): SessionEnginePorts => ({
	attachments: {
		externalize: async (messages) => [...messages],
		hydrate: async ({ messages }) => [...messages],
		release: () => undefined,
		retain: () => undefined,
	},
	commitRecord: async () => undefined,
	compaction,
	resolveCompactionSettings: async () =>
		fromPartial<ResolvedCompactionSettings>({
			autoAvailable: false,
			enabled: true,
			keepRecentTokens: 1,
			maxMediaAttachments: 4,
			maxMediaBytes: 1024,
			maxMediaTokens: 128,
			modelContextLimit: 10_000,
			overflowRecoveryAvailable: false,
			reserveTokens: 1000,
			thresholdTokens: null,
		}),
	resolveFileMentions: async () => [],
	runtime: {
		requestOverheadTokens: () => 0,
		run: async () => ({}),
	},
	skills: {
		createTurnSkill: async () =>
			fromPartial<SessionSkillCatalog>({ diagnostic: null }),
		resolveSkill: async () => ({ ok: true }),
	},
	...overrides,
});

const createEngine = (
	initialTranscript: readonly SessionMessage[],
	compactionModule = createCompactionModule(async () => ({ text: "summary" })),
	overrides: Partial<SessionEnginePorts> = {}
): SessionEngine =>
	createSessionEngine({
		initialTranscript,
		ports: createPorts({ compaction: compactionModule, ...overrides }),
		sessionId: sessionId("session-engine"),
	});

test("merges a message into the Session Transcript by id", () => {
	const engine = createEngine([message("u1", "first request")]);

	const merged = engine.mergeTranscript([
		message("a1", "answer"),
		message("u1", "edited request"),
	]);

	expect(merged.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(merged[0]?.parts[0]).toMatchObject({ text: "edited request" });
});

test("keeps a compaction summary out of the Session Transcript", () => {
	const engine = createEngine([message("u1")]);

	engine.mergeTranscript([message("compaction:entry-1", "summary")]);

	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
	]);
});

test("keeps the Session Context independent from the Session Transcript", () => {
	const engine = createEngine([message("u1"), message("a1")]);

	engine.applyContext([message("compaction:entry-1")]);
	engine.mergeTranscript([message("a2")]);

	expect(engine.getSnapshot().context.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-1"),
	]);
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
		sessionMessageId("a2"),
	]);
});

test("publishes a new Session Snapshot only when a fact changes", () => {
	const engine = createEngine([]);
	const initial = engine.getSnapshot();
	let notifications = 0;
	const unsubscribe = engine.subscribe(() => {
		notifications += 1;
	});

	// Nothing waits to be settled, so closing approvals changes no fact.
	engine.closeApprovals();
	expect(engine.getSnapshot()).toBe(initial);
	expect(notifications).toBe(0);

	engine.mergeTranscript([message("u1")]);
	expect(engine.getSnapshot()).not.toBe(initial);
	expect(notifications).toBe(1);

	unsubscribe();
	engine.mergeTranscript([message("u2")]);
	expect(notifications).toBe(1);
});

test("isolates a failing observer from session state and other observers", () => {
	const engine = createEngine([]);
	let observed = 0;
	engine.subscribe(() => {
		throw new Error("observer failed");
	});
	engine.subscribe(() => {
		observed += 1;
	});

	engine.mergeTranscript([message("u1")]);

	expect(engine.getSnapshot().transcript).toHaveLength(1);
	expect(observed).toBe(1);
});

test("runs a compaction command and publishes what it produced", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);

	const command = engine.compact({
		model,
		trigger: "threshold",
	});

	expect(engine.getSnapshot().isCompacting).toBe(true);
	release();
	const result = await command;

	const snapshot = engine.getSnapshot();
	expect(snapshot.isCompacting).toBe(false);
	expect(snapshot.compactions.map(({ id }) => id)).toEqual([result.entry.id]);
	expect(snapshot.context.map(({ id }) => id)).toEqual(
		result.activeMessages.map(({ id }) => id)
	);
});

test("joins a compaction command in flight before a caller reads the context", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const command = engine.compact({
		model,
		trigger: "threshold",
	});

	// An Agent Turn's preparation joins the command, then reads the Session
	// Context: the swap must already have landed when it resumes.
	const settled = engine.settleCompaction();
	release();
	expect(await settled).toBeNull();

	expect(engine.getSnapshot().isCompacting).toBe(false);
	expect(engine.getSnapshot().context[0]?.id).toBe(
		compactionSummaryMessageId(compactionId("entry-compacted"))
	);
	await command;
});

test("settles a joined command only after the swap it joins has landed", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const owner = engine.compact({
		model,
		trigger: "threshold",
	});
	const joined = engine.compact({
		model,
		trigger: "threshold",
	});

	release();
	await joined;

	expect(engine.getSnapshot().context[0]?.id).toBe(
		compactionSummaryMessageId(compactionId("entry-compacted"))
	);
	await owner;
});

test("refuses another intent's compaction without disturbing the running command", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const automatic = engine.compact({
		model,
		trigger: "threshold",
	});

	await expect(
		engine.compact({
			focus: "preserve database decisions",
			model,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "in-flight" });

	expect(engine.getSnapshot().isCompacting).toBe(true);
	release();
	const result = await automatic;
	expect(result.entry.trigger).toBe("threshold");
	expect(result.entry.focus).toBeUndefined();
	expect(
		engine.getSnapshot().compactions.map(({ trigger }) => trigger)
	).toEqual(["threshold"]);
});

test("cancels the compaction command in flight without publishing its result", async () => {
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule((input) => {
			const { promise, reject } = Promise.withResolvers<{ text: string }>();
			const cancel = () => reject(new Error("summary cancelled"));
			if (input.signal?.aborted) {
				cancel();
			} else {
				input.signal?.addEventListener("abort", cancel, { once: true });
			}
			return promise;
		})
	);

	const command = engine.compact({
		model,
		trigger: "threshold",
	});
	engine.cancelCompaction();

	await expect(command).rejects.toMatchObject({ code: "cancelled" });
	const snapshot = engine.getSnapshot();
	expect(snapshot.isCompacting).toBe(false);
	expect(snapshot.compactions).toEqual([]);
	expect(snapshot.context.map(({ id }) => id)).toEqual(
		compactionHistory().map(({ id }) => id)
	);
});

test("merges a command's own transcript update before compacting", async () => {
	const engine = createEngine(compactionHistory());

	const result = await engine.compact({
		model,
		nextMessages: [message("a3", "terminal answer")],
		trigger: "threshold",
	});

	expect(result.entry.trigger).toBe("threshold");
	// The update is in the Session Transcript only because the command merged it,
	// and only then can the retained tail carry it into the Session Context.
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		...compactionHistory().map(({ id }) => id),
		sessionMessageId("a3"),
	]);
	expect(engine.getSnapshot().context.map(({ id }) => id)).toContain(
		sessionMessageId("a3")
	);
});

test("compacts a command's own source without touching the Transcript", async () => {
	const engine = createEngine([message("a9", "unrelated")]);

	const result = await engine.compact({
		model,
		sourceMessages: compactionHistory(),
		trigger: "overflow",
	});

	expect(result.entry.trigger).toBe("overflow");
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual([
		sessionMessageId("a9"),
	]);
	// The retained tail comes from the supplied source, not the Transcript.
	expect(engine.getSnapshot().context.map(({ id }) => id)).toEqual([
		compactionSummaryMessageId(compactionId("entry-compacted")),
		sessionMessageId("a2"),
	]);
});

const viewState = (
	turnId: string,
	text: string
): SessionViewState & { turnId: AgentTurnId } => ({
	lastSequence: 0,
	reasoningText: "",
	status: "streaming",
	text,
	turnId: agentTurnId(turnId),
});

const executionInput = (
	turnId: AgentTurnId,
	startedAt: number,
	parent?: {
		parentToolCallId: ReturnType<typeof toolCallId>;
		parentTurnId: AgentTurnId;
	}
) => ({
	agent: agentId("build"),
	model,
	sessionModel: model,
	startedAt,
	turnId,
	...(parent === undefined ? {} : { parent }),
});

const beginExecutions = (): {
	child: AgentTurnId;
	engine: SessionEngine;
	parent: AgentTurnId;
} => {
	const engine = createEngine([]);
	const parent = agentTurnId("turn-parent");
	const child = agentTurnId("turn-child");
	engine.beginExecution(executionInput(parent, 1));
	engine.setExecutionViewState(parent, viewState("turn-parent", "parent text"));
	engine.beginExecution(
		executionInput(child, 2, {
			parentToolCallId: toolCallId("call-delegate"),
			parentTurnId: parent,
		})
	);
	return { child, engine, parent };
};

test("keeps each active execution's Session View State separate", () => {
	const { child, engine, parent } = beginExecutions();

	engine.setExecutionViewState(child, viewState("turn-child", "child text"));

	const snapshot = engine.getSnapshot();
	expect(snapshot.viewState?.text).toBe("child text");
	expect(snapshot.executions.map(({ turnId }) => turnId)).toEqual([
		parent,
		child,
	]);
	expect(snapshot.executions[0]?.viewState?.text).toBe("parent text");
	expect(snapshot.executions[1]?.parent).toEqual({
		parentToolCallId: toolCallId("call-delegate"),
		parentTurnId: parent,
	});
});

test("returns the parent's live view when a delegated execution ends", () => {
	const { child, engine } = beginExecutions();
	engine.setExecutionViewState(child, viewState("turn-child", "child text"));

	engine.endExecution(child);

	const snapshot = engine.getSnapshot();
	expect(snapshot.executions.map(({ turnId }) => turnId)).toEqual([
		agentTurnId("turn-parent"),
	]);
	expect(snapshot.viewState?.text).toBe("parent text");
});

test("exposes the newest live execution's view and drops it when it ends", () => {
	const engine = createEngine([]);
	const root = agentTurnId("turn-root");
	const first = agentTurnId("turn-first");
	const second = agentTurnId("turn-second");
	engine.beginExecution(executionInput(root, 1));
	engine.setExecutionViewState(root, viewState("turn-root", "root text"));
	engine.beginExecution(
		executionInput(first, 2, {
			parentToolCallId: toolCallId("call-1"),
			parentTurnId: root,
		})
	);
	engine.beginExecution(
		executionInput(second, 3, {
			parentToolCallId: toolCallId("call-2"),
			parentTurnId: root,
		})
	);
	engine.setExecutionViewState(first, viewState("turn-first", "first text"));
	engine.setExecutionViewState(second, viewState("turn-second", "second text"));

	expect(engine.getSnapshot().viewState?.text).toBe("second text");

	engine.endExecution(first);
	expect(engine.getSnapshot().viewState?.text).toBe("second text");

	engine.endExecution(second);
	expect(engine.getSnapshot().viewState?.text).toBe("root text");

	engine.endExecution(root);
	expect(engine.getSnapshot().viewState).toBeUndefined();
});

test("ignores a view state published for an execution that already ended", () => {
	const { child, engine } = beginExecutions();
	engine.endExecution(child);
	const ended = engine.getSnapshot();

	engine.setExecutionViewState(child, viewState("turn-child", "late text"));

	expect(engine.getSnapshot()).toBe(ended);
	expect(engine.getSnapshot().viewState?.text).toBe("parent text");
});

const approvalRequest = (callId?: string): ToolApprovalRequest => ({
	description: "Write denied by policy: src/index.ts",
	identity: [{ label: "tool", value: "write" }],
	input: { path: "src/index.ts" },
	...(callId === undefined ? {} : { toolCallId: toolCallId(callId) }),
});

test("publishes a pending approval and settles it exactly once", async () => {
	const engine = createEngine([]);
	const settled = engine.requestApproval(approvalRequest("call-1"));

	const pending = engine.getSnapshot().approvals;
	expect(pending.map(({ id, target }) => [id, target])).toEqual([
		["call-1", "tool-call"],
	]);
	expect(pending[0]?.decision).toBeUndefined();

	engine.respondToApproval("call-1", { decision: "allow", remember: false });

	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "allow",
		remember: false,
	});

	// A second trigger cannot settle a request the Engine already settled.
	engine.respondToApproval("call-1", { decision: "abort" });
	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "allow",
		remember: false,
	});
});

test("gives a Tool-Call-less approval its own id and settles it with every sibling", async () => {
	const engine = createEngine([]);
	const first = engine.requestApproval(approvalRequest());
	const second = engine.requestApproval(approvalRequest());
	const [firstEntry, secondEntry] = engine.getSnapshot().approvals;

	expect(firstEntry?.target).toBe("session");
	expect(firstEntry?.id).toBeString();
	expect(firstEntry?.id).not.toBe(secondEntry?.id);

	engine.closeApprovals();
	await expect(first).resolves.toEqual({ decision: "reject" });
	await expect(second).resolves.toEqual({ decision: "reject" });
});

test("settles every pending approval when approvals close", async () => {
	const engine = createEngine([]);
	const first = engine.requestApproval(approvalRequest("call-1"));
	const second = engine.requestApproval(approvalRequest("call-2"));

	engine.closeApprovals("use the config loader");

	// The newest pending request carries the feedback and every sibling is
	// rejected without one, so no waiting Tool Gate evaluation is left open.
	await expect(second).resolves.toEqual({
		decision: "reject",
		feedback: "use the config loader",
	});
	await expect(first).resolves.toEqual({ decision: "reject" });
	expect(
		engine.getSnapshot().approvals.map(({ decision }) => decision)
	).toEqual([
		{ decision: "reject" },
		{ decision: "reject", feedback: "use the config loader" },
	]);
});

test("settles a pending approval when the session shuts down", async () => {
	const engine = createEngine([]);
	const settled = engine.requestApproval(approvalRequest("call-1"));

	await engine.shutdown();

	await expect(settled).resolves.toEqual({ decision: "reject" });
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "reject",
	});
});

test("settles an approval that arrives after the session shut down", async () => {
	const engine = createEngine([]);
	await engine.shutdown();

	await expect(
		engine.requestApproval(approvalRequest("call-1"))
	).resolves.toEqual({ decision: "reject" });
	expect(engine.getSnapshot().approvals).toEqual([]);
});

test("refuses a second pending request that reuses a Tool Call Identifier", async () => {
	const engine = createEngine([]);
	const first = engine.requestApproval(approvalRequest("call-1"));
	const duplicate = engine.requestApproval(approvalRequest("call-1"));

	await expect(duplicate).resolves.toEqual({ decision: "reject" });
	expect(engine.getSnapshot().approvals).toHaveLength(1);

	// The identifier still addresses the request the panel shows.
	engine.respondToApproval("call-1", { decision: "allow", remember: false });
	await expect(first).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
});

test("keeps the first settlement when an abort and a close race", async () => {
	const engine = createEngine([]);
	const aborted = engine.requestApproval(approvalRequest("call-1"));
	const sibling = engine.requestApproval(approvalRequest("call-2"));

	engine.respondToApproval("call-1", { decision: "abort" });
	engine.closeApprovals();

	await expect(aborted).resolves.toEqual({ decision: "abort" });
	await expect(sibling).resolves.toEqual({ decision: "reject" });
});

/** The provider refusal one recovery is proposed for. */
const overflowFailure = (): Error =>
	new Error("This model's maximum context length is 128000 tokens.");

const recoveryTarget: SessionOverflowRecoveryTarget = { model };

const recoveryCommand = ({
	error = overflowFailure(),
	messageId = "u2",
	replay = async () => ({ kind: "started" }) as const,
	target = recoveryTarget as SessionOverflowRecoveryTarget | null,
	turnId = "turn-overflow",
}: {
	error?: unknown;
	messageId?: string;
	replay?: () => Promise<SessionOverflowReplayOutcome>;
	target?: SessionOverflowRecoveryTarget | null;
	turnId?: string;
} = {}): SessionOverflowRecoveryCommand => ({
	error,
	originalMessageId: sessionMessageId(messageId),
	replay,
	resolveTarget: async () => target,
	turnId: agentTurnId(turnId),
});
test("refuses compaction and overflow recovery after shutdown", async () => {
	const engine = createEngine([]);
	await engine.shutdown();

	await expect(
		engine.compact({ model, trigger: "manual" })
	).rejects.toMatchObject({ code: "cancelled" });
	await expect(engine.recoverOverflow(recoveryCommand())).resolves.toEqual({
		kind: "ineligible",
	});
});

test("recovers a context-overflow failure with one compaction and one replay", async () => {
	const engine = createEngine(compactionHistory());
	const replay = mock(async () => ({ kind: "started" }) as const);

	const outcome = await engine.recoverOverflow(recoveryCommand({ replay }));

	expect(outcome).toMatchObject({
		entry: { trigger: "overflow" },
		kind: "recovered",
	});
	expect(replay).toHaveBeenCalledWith({
		originalMessageId: sessionMessageId("u2"),
	});
	// The compaction the recovery ran is the Engine's own compaction command:
	// the Session Context swap and the entry land exactly as for any other one.
	const snapshot = engine.getSnapshot();
	expect(snapshot.compactions.map(({ trigger }) => trigger)).toEqual([
		"overflow",
	]);
	expect(snapshot.context.map(({ id }) => id)).toEqual([
		compactionSummaryMessageId(compactionId("entry-compacted")),
		sessionMessageId("u2"),
	]);
	expect(snapshot.compactionError).toBeNull();
});

test("recovers a failure the provider reported as an Operational Failure", async () => {
	const engine = createEngine(compactionHistory());

	const outcome = await engine.recoverOverflow(
		recoveryCommand({
			error: createOperationalFailure({
				code: "context-overflow",
				retry: "with-changes",
				source: "model",
			}),
		})
	);

	expect(outcome).toMatchObject({ kind: "recovered" });
});

test("recovers a message once, even when the replayed turn fails the same way", async () => {
	const engine = createEngine(compactionHistory());
	const replay = mock(async () => ({ kind: "started" }) as const);
	const recovered = await engine.recoverOverflow(
		recoveryCommand({ replay, turnId: "turn-1" })
	);
	expect(recovered).toMatchObject({ kind: "recovered" });

	// The replayed Agent Turn answers the same user message, and the provider
	// refuses it again: that is still this message's one attempt, so no send —
	// the replay's own or a user's — can start another recovery of it.
	engine.beginExecution(executionInput(agentTurnId("turn-2"), 2));
	const exhausted = engine.recoverOverflow(
		recoveryCommand({ replay, turnId: "turn-2" })
	);
	engine.endExecution(agentTurnId("turn-2"));

	expect(await exhausted).toEqual({ kind: "exhausted" });
	expect(replay).toHaveBeenCalledTimes(1);
	expect(engine.getSnapshot().compactions).toHaveLength(1);
});

test("records the attempt when the recovery starts, not when it finishes", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const recovery = engine.recoverOverflow(
		recoveryCommand({ turnId: "turn-1" })
	);
	// Another Agent Turn starts while the recovery compacts; the recovery under
	// way keeps its attempt.
	engine.beginExecution(executionInput(agentTurnId("turn-2"), 2));
	const duplicate = engine.recoverOverflow(
		recoveryCommand({ turnId: "turn-2" })
	);
	engine.endExecution(agentTurnId("turn-2"));

	release();

	// The duplicate is refused while the recovery it would join still compacts:
	// an attempt recorded only when the compaction finished would admit it.
	await expect(duplicate).resolves.toEqual({ kind: "exhausted" });
	await expect(recovery).resolves.toMatchObject({ kind: "recovered" });
});

test("ignores a failure that is not a context overflow", async () => {
	const engine = createEngine(compactionHistory());
	const replay = mock(async () => ({ kind: "started" }) as const);

	const outcome = await engine.recoverOverflow(
		recoveryCommand({ error: new Error("authentication failed"), replay })
	);

	expect(outcome).toEqual({ kind: "ineligible" });
	expect(replay).not.toHaveBeenCalled();
	expect(engine.getSnapshot().compactions).toEqual([]);
});

test("ignores an overflow for a Model Target without recovery", async () => {
	const engine = createEngine(compactionHistory());
	const replay = mock(async () => ({ kind: "started" }) as const);

	const outcome = await engine.recoverOverflow(
		recoveryCommand({ replay, target: null })
	);

	expect(outcome).toEqual({ kind: "ineligible" });
	expect(replay).not.toHaveBeenCalled();
	expect(engine.getSnapshot().compactions).toEqual([]);

	// Nothing was tried, so the message keeps its one attempt: an eligible
	// refusal of the same message still recovers.
	await expect(
		engine.recoverOverflow(recoveryCommand({ replay }))
	).resolves.toMatchObject({ kind: "recovered" });
	expect(replay).toHaveBeenCalledTimes(1);
});

test("reports a failed compaction without replaying the message", async () => {
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(() => Promise.reject(new Error("summary failed")))
	);
	const replay = mock(async () => ({ kind: "started" }) as const);

	const outcome = await engine.recoverOverflow(recoveryCommand({ replay }));

	expect(outcome).toMatchObject({
		error: { code: "replay-failed" },
		kind: "failed",
	});
	expect(outcome.kind === "failed" && outcome.error.message).toContain(
		"could not compact the session"
	);
	expect(replay).not.toHaveBeenCalled();
	expect(engine.getSnapshot().compactionError?.message).toContain(
		"summary generation failed"
	);
	expect(engine.getSnapshot().compactions).toEqual([]);
});

test("reports a replay the session refused instead of overlapping it", async () => {
	const engine = createEngine(compactionHistory());
	const replay = mock(
		async () =>
			({
				kind: "refused",
				reason: "A session send is already active.",
			}) as const
	);

	const outcome = await engine.recoverOverflow(recoveryCommand({ replay }));

	expect(outcome).toMatchObject({
		error: { code: "replay-refused" },
		kind: "failed",
	});
	expect(replay).toHaveBeenCalledTimes(1);
	const snapshot = engine.getSnapshot();
	expect(snapshot.compactionError?.message).toContain(
		"A session send is already active."
	);
	// Refusing the replay does not undo the compaction the recovery ran.
	expect(snapshot.compactions.map(({ trigger }) => trigger)).toEqual([
		"overflow",
	]);
});

test("replays only after the Agent Turn that proposed the recovery has ended", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const replay = mock(async () => ({ kind: "started" }) as const);
	engine.beginExecution(executionInput(agentTurnId("turn-overflow"), 1));
	const compactionStarted = new Promise<void>((resolve) => {
		const unsubscribe = engine.subscribe(() => {
			if (engine.getSnapshot().isCompacting) {
				unsubscribe();
				resolve();
			}
		});
	});

	const recovery = engine.recoverOverflow(recoveryCommand({ replay }));
	await compactionStarted;
	release();
	await engine.settleCompaction();

	// The compaction has landed, and the replay still waits for the turn that
	// proposed the recovery: without that wait it would start here, while the
	// execution that asked for it is still live.
	expect(replay).not.toHaveBeenCalled();

	engine.endExecution(agentTurnId("turn-overflow"));

	await expect(recovery).resolves.toMatchObject({ kind: "recovered" });
	expect(replay).toHaveBeenCalledTimes(1);
});

test("does not replay overflow recovery after shutdown", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const replay = mock(async () => ({ kind: "started" }) as const);
	engine.beginExecution(executionInput(agentTurnId("turn-overflow"), 1));
	const compactionStarted = new Promise<void>((resolve) => {
		const unsubscribe = engine.subscribe(() => {
			if (engine.getSnapshot().isCompacting) {
				unsubscribe();
				resolve();
			}
		});
	});

	const recovery = engine.recoverOverflow(
		recoveryCommand({ replay, turnId: "turn-overflow" })
	);
	await compactionStarted;
	release();
	await engine.settleCompaction();
	const shutdown = engine.shutdown();
	engine.endExecution(agentTurnId("turn-overflow"));

	await shutdown;
	await expect(recovery).resolves.toEqual({ kind: "ineligible" });
	expect(replay).not.toHaveBeenCalled();
});

/** One submission as a view sends it: a prompt, its selection, its Agent. */
const sendInput = (
	overrides: Partial<SessionSendInput> = {}
): SessionSendInput => ({
	agent: agentId("build"),
	model,
	resolvedAgent: fromPartial<ResolvedCodingAgent>({}),
	sessionModel: model,
	userText: "hello",
	...overrides,
});

/** The visible composition one submission is accepted with. */
const compositionOf = (
	text: string,
	files: SessionFilePart[] = []
): SessionSubmissionComposition => ({
	files,
	text,
});

/** The prompt of every user message in a conversation, in order. */
const userPrompts = (messages: readonly SessionMessage[]): string[] =>
	messages.flatMap(({ parts, role }) =>
		role === "user"
			? parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
			: []
	);

/** The prompt one Agent Turn sends: its newest user message. */
const promptOfTurn = (messages: readonly SessionMessage[]): string =>
	userPrompts(messages).at(-1) ?? "";

/**
 * A runtime that holds every Agent Turn until the test releases it, one release
 * per started turn, and records what each turn ran with, so queue order is
 * observed through awaited starts rather than through waiting on real time.
 * With `boundary` it also models one Model Step boundary per turn: it asks the
 * Engine what joined the turn and records what it was handed, exactly where a
 * real runtime inserts a Steering Message before its next model call.
 */
const createQueuedRuntime = ({
	boundary = false,
}: {
	boundary?: boolean;
} = {}): {
	/**
	 * What each Model Step boundary of each turn was handed, in boundary order,
	 * with the message that turn still answers when it delivered.
	 */
	readonly boundaries: Array<{
		readonly delivered: string[];
		readonly sourceUserMessageId: SessionMessageId | null;
	}>;
	/** The prompt each started turn answers, in start order. */
	readonly prompts: string[];
	/** Lets the oldest started Agent Turn finish. */
	readonly release: () => void;
	readonly runtime: SessionEnginePorts["runtime"];
	/** Resolves once `count` Agent Turns have started. */
	readonly started: (count: number) => Promise<void>;
	/** The Model Target selection each started turn ran with, in start order. */
	readonly targets: Array<{
		model: ChatModelSelection;
		variant: ModelVariant | undefined;
	}>;
} => {
	const boundaries: Array<{
		delivered: string[];
		sourceUserMessageId: SessionMessageId | null;
	}> = [];
	const gates: Array<() => void> = [];
	const prompts: string[] = [];
	const targets: Array<{
		model: ChatModelSelection;
		variant: ModelVariant | undefined;
	}> = [];
	const startWaiters: Array<{ count: number; resolve: () => void }> = [];
	let startedCount = 0;
	const settleReached = (
		waiters: Array<{ count: number; resolve: () => void }>,
		count: number
	): void => {
		for (const waiter of waiters.filter(({ count: at }) => at <= count)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	const awaited = (
		waiters: Array<{ count: number; resolve: () => void }>,
		reached: number,
		count: number
	): Promise<void> => {
		if (count <= reached) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		return promise;
	};
	return {
		boundaries,
		prompts,
		release: () => gates.shift()?.(),
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(promptOfTurn(messages));
				targets.push({ model: execution.model, variant: execution.variant });
				startedCount += 1;
				settleReached(startWaiters, startedCount);
				const gate = Promise.withResolvers<void>();
				gates.push(gate.resolve);
				await gate.promise;
				if (boundary) {
					boundaries.push({
						delivered: userPrompts(takeSteeringMessages()),
						sourceUserMessageId: execution.sourceUserMessageId,
					});
				}
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
		started: (count) => awaited(startWaiters, startedCount, count),
		targets,
	};
};

test("queues a submission that arrives while a compaction is in flight", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	const accepted = await engine.send(
		sendInput({ composition: compositionOf("queued"), userText: "queued" })
	);

	expect(accepted).toEqual({ rejected: false });
	const queued = engine.getSnapshot().queuedSubmissions;
	expect(queued.map(({ input }) => input.composition.text)).toEqual(["queued"]);
	// A Queued Submission is not a Session Record: nothing has entered the
	// Session Transcript but what the compaction already left there.
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual(
		userPrompts(compactionHistory())
	);

	release();
	await compaction;
	await runtime.started(1);
	expect(runtime.prompts).toEqual(["queued"]);
	runtime.release();

	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	expect(userPrompts(engine.getSnapshot().transcript).at(-1)).toBe("queued");
});

test("drains the Submission Queue in order, one Agent Turn at a time", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "one" }));
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));
	expect(engine.getSnapshot().queuedSubmissions).toHaveLength(3);

	release();
	await compaction;
	await runtime.started(1);
	// The first submission runs alone; the rest still wait.
	expect(runtime.prompts).toEqual(["one"]);
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "two"]);
	runtime.release();
	await runtime.started(3);
	expect(runtime.prompts).toEqual(["one", "two", "three"]);
	runtime.release();

	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	expect(
		userPrompts(engine.getSnapshot().transcript).slice(
			userPrompts(compactionHistory()).length
		)
	).toEqual(["one", "two", "three"]);
});

test("drains submissions queued while a compaction was in flight", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	const accepted = await engine.send(sendInput({ userText: "queued" }));

	expect(accepted).toEqual({ rejected: false });
	expect(
		engine
			.getSnapshot()
			.queuedSubmissions.map(({ input }) => input.composition.text)
	).toEqual(["queued"]);
	expect(runtime.prompts).toEqual([]);

	release();
	await compaction;
	await runtime.started(1);
	// The queue waited for the compaction and then ran as its own turn.
	expect(runtime.prompts).toEqual(["queued"]);
	runtime.release();
});

test("keeps draining the Submission Queue after a turn fails", async () => {
	const prompts: string[] = [];
	const drained = Promise.withResolvers<void>();
	const engine = createEngine([], undefined, {
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ messages }) => {
				prompts.push(promptOfTurn(messages));
				if (prompts.length === 1) {
					return { error: new Error("The provider refused the request.") };
				}
				if (prompts.length === 2) {
					drained.resolve();
				}
				return {};
			},
		},
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await first;
	await engine.send(sendInput({ userText: "two" }));

	await drained.promise;
	expect(prompts).toEqual(["one", "two"]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
});

test("drains the Submission Queue after a cancelled turn", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "one" }));
	await engine.send(sendInput({ userText: "two" }));

	release();
	await compaction;
	await runtime.started(1);
	engine.cancel();
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "two"]);

	runtime.release();
	// A cancelled turn never strands the submissions behind it.
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
});

test("interrupts a turn by recalling the Steering Lane instead of running it", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createEngine([], undefined, { runtime: runtime.runtime });

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	const marked: SessionSubmissionComposition = {
		fileTokens: [{ start: 0, token: "[Image 1] " }],
		files: [],
		pastedText: [{ text: "many lines", token: "[Pasted ~9 lines]" }],
		text: "[Image 1] [Pasted ~9 lines] two",
	};
	await engine.send(sendInput({ composition: marked, userText: "two" }));
	await engine.send(
		sendInput({ composition: compositionOf("three"), userText: "three" })
	);

	const recalled = engine.interrupt();

	// Everything waiting comes back, in the order it would have been delivered.
	expect(recalled.map(({ input }) => input.composition.text)).toEqual([
		marked.text,
		"three",
	]);
	// Recall restores the composition the message was composed with, markers and
	// pasted text included.
	expect(recalled[0]?.input.composition).toEqual(marked);
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	runtime.release();
	await first;
	// The interrupted turn delivered nothing, so no turn ran behind it and a
	// fresh submission runs at once instead of waiting behind recalled work.
	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([[]]);
	void engine.send(sendInput({ userText: "fresh" }));
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["one", "fresh"]);

	runtime.release();
	expect(engine.recallWaitingMessages()).toEqual([]);
});

test("recalls the Steering Lane ahead of the Submission Queue", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	// Two submissions wait in the Submission Queue while the compaction holds
	// the lane; the drain then runs the first of them with the second still
	// waiting, which is the one moment both lanes can hold something.
	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "queued-first" }));
	await engine.send(sendInput({ userText: "queued-second" }));
	release();
	await compaction;
	await runtime.started(1);
	await engine.send(sendInput({ userText: "steer" }));

	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.text)
	).toEqual(["steer"]);
	expect(
		engine
			.getSnapshot()
			.queuedSubmissions.map(({ input }) => input.composition.text)
	).toEqual(["queued-second"]);

	const head = engine.getSnapshot().steeringMessages[0];
	expect(head).toBeDefined();
	const recalledHead = engine.recallWaitingMessages(
		head ? [head.id] : undefined
	);
	// The Steering head is what the next Model Step boundary delivers, so it is
	// the message the next Recall takes back; the queued one keeps waiting.
	expect(recalledHead.map(({ input }) => input.composition.text)).toEqual([
		"steer",
	]);
	expect(
		engine
			.getSnapshot()
			.queuedSubmissions.map(({ input }) => input.composition.text)
	).toEqual(["queued-second"]);

	const everything = engine.interrupt();
	expect(everything.map(({ input }) => input.composition.text)).toEqual([
		"queued-second",
	]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	runtime.release();
});

test("delivers a submission accepted while a turn is running into that turn", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commits: SessionRecord[] = [];
	const engine = createEngine([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		runtime: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	const accepted = await engine.send(sendInput({ userText: "correction" }));

	expect(accepted).toEqual({ rejected: false });
	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.text)
	).toEqual(["correction"]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	// A Steering Message is not a Session Record until it is delivered.
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual(["one"]);

	runtime.release();
	await first;

	// The turn's Model Step boundary handed it over, and the Transcript holds it
	// as a user message of that same turn.
	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([
		["correction"],
	]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"correction",
	]);
	// It ran inside the turn it joined instead of starting one of its own.
	expect(runtime.prompts).toEqual(["one"]);
	expect(engine.getSnapshot().steeringMessages).toEqual([]);

	const opening = commits[0]?.messages[0];
	const steering = commits[1];
	expect(commits.map(({ outcome }) => outcome.kind)).toEqual([
		"user",
		"user",
		"assistant",
	]);
	// The delivered message names the Agent Turn it joined, and the turn still
	// answers the message that opened it.
	expect(steering?.messages[0]?.metadata?.joinedTurnId).toBe(steering?.turnId);
	expect(runtime.boundaries[0]?.sourceUserMessageId).toBe(opening?.id);
});

test("waits for a delivered Steering checkpoint before shutdown settles", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commitStarted = Promise.withResolvers<void>();
	const allowCommit = Promise.withResolvers<void>();
	let steeringCommitted = false;
	const engine = createEngine([], undefined, {
		commitRecord: async ({ record }) => {
			const message = record.messages[0];
			if (
				record.outcome.kind === "user" &&
				message?.metadata?.joinedTurnId !== undefined
			) {
				commitStarted.resolve();
				await allowCommit.promise;
				steeringCommitted = true;
			}
		},
		runtime: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "correction" }));
	runtime.release();
	await commitStarted.promise;
	await first;

	const shutdown = engine.shutdown();
	const probe = Promise.withResolvers<"probe">();
	queueMicrotask(() => probe.resolve("probe"));
	const result = await Promise.race([
		shutdown.then(() => "shutdown" as const),
		probe.promise,
	]);
	expect(result).toBe("probe");

	allowCommit.resolve();
	await shutdown;
	expect(steeringCommitted).toBe(true);
});

test("delivers Steering Messages in the order they were accepted", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createEngine([], undefined, { runtime: runtime.runtime });

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));

	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.text)
	).toEqual(["two", "three"]);

	runtime.release();
	await first;

	expect(runtime.boundaries.map(({ delivered }) => delivered)).toEqual([
		["two", "three"],
	]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"two",
		"three",
	]);
});

test("keeps the Model Target of the turn a Steering Message joined", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const commits: SessionRecord[] = [];
	const engine = createEngine([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		runtime: runtime.runtime,
	});
	const otherModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	// The composer's selection changes while the turn runs: the correction still
	// joins the turn on the Model Target that turn already runs with.
	await engine.send(sendInput({ model: otherModel, userText: "correction" }));

	runtime.release();
	await first;

	// The turn ran on its own Model Target, and the delivered message records
	// that same one rather than the composer's newer selection.
	expect(runtime.targets).toEqual([{ model, variant: undefined }]);
	expect(commits[1]?.messages[0]?.metadata?.model).toEqual(model);
});

test("hands a Steering Message to the Submission Queue when the turn has no boundary", async () => {
	// A tool-less turn runs exactly one Model Step, so its runtime never reaches
	// a boundary to deliver at.
	const runtime = createQueuedRuntime();
	const engine = createEngine([], undefined, { runtime: runtime.runtime });

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "correction" }));
	expect(engine.getSnapshot().steeringMessages).toHaveLength(1);

	runtime.release();
	await runtime.started(2);

	// Nothing was dropped: the message left the Steering Lane for the queue and
	// now runs as its own Agent Turn.
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(runtime.prompts).toEqual(["one", "correction"]);
	runtime.release();
	await first;

	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"one",
		"correction",
	]);
});

test("keeps a Steering Message that fell back on the Model Target it was accepted with", async () => {
	const runtime = createQueuedRuntime();
	const engine = createEngine([], undefined, { runtime: runtime.runtime });
	const otherModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ model: otherModel, userText: "correction" }));

	runtime.release();
	await runtime.started(2);

	// The fallback runs as a submission of its own, so it keeps the selection it
	// was accepted with rather than inheriting the turn it could not join.
	expect(runtime.targets).toEqual([
		{ model, variant: undefined },
		{ model: otherModel, variant: undefined },
	]);
	runtime.release();
	await first;
});

test("hands a fallback Steering Message to the queue behind what already waits", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "queued-first" }));
	await engine.send(sendInput({ userText: "queued-second" }));
	release();
	await compaction;
	await runtime.started(1);
	await engine.send(sendInput({ userText: "steer" }));

	runtime.release();
	await runtime.started(2);
	runtime.release();
	await runtime.started(3);

	// Acceptance order is kept: the submissions that waited first run first, and
	// the message that could not steer still runs as its own Agent Turn.
	expect(runtime.prompts).toEqual(["queued-first", "queued-second", "steer"]);
	runtime.release();
});

test("refuses a Steering Message that invokes a Skill or resends another message", async () => {
	const runtime = createQueuedRuntime();
	const engine = createEngine([], undefined, { runtime: runtime.runtime });

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);

	await expect(
		engine.send(
			sendInput({
				skill: fromPartial<SessionSendInput["skill"]>({ name: "review" }),
				userText: "review this",
			})
		)
	).resolves.toEqual({
		rejected: true,
		reason: "A Steering Message cannot invoke a Skill: it carries text only.",
	});
	await expect(
		engine.send(
			sendInput({ messageId: sessionMessageId("stored"), userText: "" })
		)
	).resolves.toEqual({
		rejected: true,
		reason:
			"A Steering Message carries text only: it cannot resend or edit another message.",
	});
	expect(engine.getSnapshot().steeringMessages).toEqual([]);

	runtime.release();
	await first;
});

test("recalls part of the queue by identifier and ignores an unknown one", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);

	// The submissions are accepted while a compaction holds the lane — the
	// session is busy without a running Agent Turn — so they queue.
	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "two" }));
	await engine.send(sendInput({ userText: "three" }));
	const waiting = engine.getSnapshot().queuedSubmissions;
	const second = waiting[0]?.id ?? queuedSubmissionId("missing");
	const third = waiting[1]?.id ?? queuedSubmissionId("missing");

	expect(
		engine
			.recallWaitingMessages([second])
			.map(({ input }) => input.composition.text)
	).toEqual(["two"]);
	expect(engine.getSnapshot().queuedSubmissions.map(({ id }) => id)).toEqual([
		third,
	]);
	// An identifier that names nothing waiting changes nothing.
	expect(engine.recallWaitingMessages([second])).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions.map(({ id }) => id)).toEqual([
		third,
	]);

	release();
	await compaction;
	await runtime.started(1);
	// Only the submission that was left behind runs.
	expect(runtime.prompts).toEqual(["three"]);
	runtime.release();
});

test("runs a queued submission with the Model Target selection it was accepted with", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ runtime: runtime.runtime }
	);
	const queuedModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ model: queuedModel, userText: "two" }));

	release();
	await compaction;
	await runtime.started(1);
	// The selection the submission was accepted with is the one that runs, even
	// though the session's own selection could change while it waits.
	expect(runtime.targets).toEqual([{ model: queuedModel, variant: undefined }]);

	runtime.release();
});

test("steers the Agent Turn an overflow replay runs", async () => {
	const gates: Array<() => void> = [];
	const prompts: string[] = [];
	const delivered: string[][] = [];
	const replayStarted = Promise.withResolvers<void>();
	const engine = createEngine(compactionHistory(), undefined, {
		resolveCompactionSettings: async () =>
			fromPartial<ResolvedCompactionSettings>({
				autoAvailable: false,
				enabled: true,
				keepRecentTokens: 1,
				maxMediaAttachments: 4,
				maxMediaBytes: 1024,
				maxMediaTokens: 128,
				modelContextLimit: 10_000,
				overflowRecoveryAvailable: true,
				reserveTokens: 1000,
				thresholdTokens: null,
			}),
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, messages, takeSteeringMessages }) => {
				prompts.push(promptOfTurn(messages));
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				if (prompts.length === 1) {
					return { error: overflowFailure() };
				}
				replayStarted.resolve();
				const gate = Promise.withResolvers<void>();
				gates.push(gate.resolve);
				await gate.promise;
				delivered.push(userPrompts(takeSteeringMessages()));
				await callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						messages: [
							{
								id: sessionMessageId(`assistant-${execution.turnId}`),
								parts: [{ text: "answer", type: "text" }],
								role: "assistant",
							},
						],
						outcome: {
							kind: "assistant",
							terminal: { finishedAt: 2, kind: "completed" },
						},
						turnId: execution.turnId,
					})
				);
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 2,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
	});

	const send = engine.send(sendInput({ userText: "first" }));
	// The provider refusal buys the turn one recovery, whose replay runs the
	// original message again on the send lane.
	await replayStarted.promise;
	const accepted = await engine.send(sendInput({ userText: "second" }));

	// The replay is the Agent Turn the session is running, so the submission
	// joins that turn's Steering Lane instead of waiting for it to end.
	expect(accepted).toEqual({ rejected: false });
	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.text)
	).toEqual(["second"]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	gates.shift()?.();
	await send;
	// The replay turn delivered it at its Model Step boundary and ran no turn of
	// its own for it.
	expect(delivered).toEqual([["second"]]);
	expect(prompts).toEqual(["first", "first"]);
	expect(userPrompts(engine.getSnapshot().transcript).at(-1)).toBe("second");
});

test("retains a queued submission's attachments until its turn runs", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const retained: string[][] = [];
	const released: string[][] = [];
	const holdEnded = Promise.withResolvers<void>();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) =>
					messages.map((sessionMessage) => ({
						...sessionMessage,
						parts: sessionMessage.parts.map((part) =>
							part.type === "file"
								? fromPartial<SessionFilePart>({
										attachmentId: attachmentId("stored-blob"),
										mediaType: part.mediaType,
										type: "file",
										url: "attachment://stored-blob",
									})
								: part
						),
					})),
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => {
					released.push([...attachmentIds]);
					holdEnded.resolve();
				},
				retain: (attachmentIds) => retained.push([...attachmentIds]),
			},
			runtime: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];

	// Attachments are refused on a Steering Message, so a submission that
	// carries one waits for the queue: the compaction is what holds the lane.
	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({
			composition: compositionOf("[Image 1]", files),
			files,
			userText: "[Image 1]",
		})
	);

	// The queued composition stores its attachments and keeps their blobs, so a
	// long wait cannot reclaim them.
	expect(retained).toEqual([["stored-blob"]]);
	expect(
		engine.getSnapshot().queuedSubmissions[0]?.input.composition.files
	).toEqual([expect.objectContaining({ attachmentId: "stored-blob" })]);

	release();
	await compaction;
	await runtime.started(1);
	expect(released).toEqual([]);
	runtime.release();

	// Running the turn puts the blobs in Session Records, so the hold ends then.
	await holdEnded.promise;
	expect(released).toEqual([["stored-blob"]]);
});

test("waits for queued attachment externalization before shutdown settles", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => {
					externalizeStarted.resolve();
					await allowExternalize.promise;
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
			runtime: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		{
			filename: "clipboard.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,AAAA",
		},
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);
	await externalizeStarted.promise;
	engine.cancelCompaction();
	const shutdown = engine.shutdown();
	const probe = Promise.withResolvers<"probe">();
	queueMicrotask(() => probe.resolve("probe"));
	const result = await Promise.race([
		shutdown.then(() => "shutdown" as const),
		probe.promise,
	]);
	expect(result).toBe("probe");

	allowExternalize.resolve();
	release();
	await expect(queued).resolves.toMatchObject({
		rejected: true,
		reason: "The session has ended.",
	});
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await shutdown;
});

test("refuses a submission that carries attachments into a running turn", async () => {
	const runtime = createQueuedRuntime();
	const engine = createEngine([], undefined, { runtime: runtime.runtime });
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("unpaid-blob"),
			type: "file",
			url: "attachment://unpaid-blob",
		}),
	];

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	const outcome = await engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);

	// A Steering Message carries text only, so the running turn is never
	// promised a delivery it cannot pay for.
	expect(outcome).toEqual({
		rejected: true,
		reason:
			"A Steering Message carries text only: attachments are not accepted.",
	});
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	runtime.release();
	await first;
});

test("drops the queue and its attachment holds when the session shuts down", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const released: string[][] = [];
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			runtime: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("dropped-blob"),
			type: "file",
			url: "attachment://dropped-blob",
		}),
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);

	const shutdown = engine.shutdown();

	expect(released).toEqual([["dropped-blob"]]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	release();
	await compaction;
	await shutdown;
});

test("refuses a submission once the session has shut down", async () => {
	const engine = createEngine([]);
	await engine.shutdown();

	await expect(engine.send(sendInput())).resolves.toEqual({
		rejected: true,
		reason: "The session has ended.",
	});
});

test("releases a recalled submission's attachment hold", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const released: string[][] = [];
	const engine = createEngine(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			runtime: runtime.runtime,
		}
	);
	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("held-blob"),
			type: "file",
			url: "attachment://held-blob",
		}),
	];

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(
		sendInput({ composition: compositionOf("[Image 1]", files), files })
	);

	engine.recallWaitingMessages();

	expect(released).toEqual([["held-blob"]]);
	release();
	await compaction;
});

/** A turn that streams one answer through the callbacks it is handed. */
const answeringRuntime = (): SessionEnginePorts["runtime"] => ({
	requestOverheadTokens: () => 0,
	run: async ({ callbacks, execution }) => {
		callbacks.onEvent({
			agentId: execution.agent,
			sequence: 0,
			startedAt: 1,
			turnId: execution.turnId,
			type: "agent-turn-started",
		});
		callbacks.onEvent({
			delta: "hello back",
			sequence: 1,
			turnId: execution.turnId,
			type: "text-delta",
		});
		await callbacks.commitTerminal(
			fromPartial<SessionRecord>({
				messages: [
					{
						id: sessionMessageId(`assistant-${execution.turnId}`),
						parts: [{ text: "hello back", type: "text" }],
						role: "assistant",
					},
				],
				outcome: {
					kind: "assistant",
					terminal: { finishedAt: 2, kind: "completed" },
				},
				turnId: execution.turnId,
			})
		);
		callbacks.onTerminal({
			finishedAt: 2,
			sequence: 2,
			turnId: execution.turnId,
			type: "agent-turn-completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		return {};
	},
});

/** A turn that streams one delta and then waits to be let go. */
const createStreamingRuntime = (): {
	/** Resolves once the turn has streamed and is waiting to be let go. */
	readonly live: Promise<void>;
	readonly release: () => void;
	readonly runtime: SessionEnginePorts["runtime"];
} => {
	const parked = Promise.withResolvers<void>();
	const live = Promise.withResolvers<void>();
	return {
		live: live.promise,
		release: parked.resolve,
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution }) => {
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				callbacks.onEvent({
					delta: "partial",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				live.resolve();
				await parked.promise;
				return { error: new Error("The Agent Turn was interrupted.") };
			},
		},
	};
};

test("commits the accepted prompt and streams its Agent Turn", async () => {
	const commits: SessionRecord[] = [];
	const engine = createEngine([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		runtime: answeringRuntime(),
	});

	const outcome = await engine.send(sendInput());

	expect(outcome).toEqual({ rejected: false });
	const prompt = engine
		.getSnapshot()
		.context.find(({ role }) => role === "user");
	expect(prompt?.parts[0]).toMatchObject({ text: "hello", type: "text" });
	const assistant = engine.getSnapshot().context.at(-1);
	expect(assistant?.role).toBe("assistant");
	expect(assistant?.parts[0]).toMatchObject({ text: "hello back" });
	// The prompt is durable before the turn runs, and the terminal row follows it.
	expect(commits).toHaveLength(2);
	expect(commits[0]?.outcome).toEqual({ kind: "user" });
	expect(commits[1]?.outcome).toMatchObject({
		kind: "assistant",
		terminal: { kind: "completed" },
	});
	expect(engine.getSnapshot().transcript.map(({ id }) => id)).toEqual(
		engine.getSnapshot().context.map(({ id }) => id)
	);
	expect(engine.getSnapshot().turnActive).toBe(false);
});

test("retries a stored message without appending another user message", async () => {
	const commits: SessionRecord[] = [];
	const engine = createEngine([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		runtime: answeringRuntime(),
	});
	// A reopened session already holds the stored prompt in its Session Context.
	const stored = message("u1", "retry me");
	engine.applyContext([stored]);
	engine.mergeTranscript([stored]);

	const outcome = await engine.send(
		sendInput({ messageId: sessionMessageId("u1"), userText: undefined })
	);

	expect(outcome).toEqual({ rejected: false });
	const context = engine.getSnapshot().context;
	expect(context.filter(({ role }) => role === "user")).toHaveLength(1);
	expect(context.at(-1)?.role).toBe("assistant");
	// The retry reuses the stored message, so no second prompt row is committed.
	expect(commits.map(({ outcome: record }) => record)).toEqual([
		{
			kind: "assistant",
			terminal: expect.objectContaining({ kind: "completed" }),
		},
	]);
});

test("cancels the submission it is running and returns to ready", async () => {
	const streaming = createStreamingRuntime();
	const engine = createEngine([], undefined, { runtime: streaming.runtime });

	const send = engine.send(sendInput());
	engine.cancel();

	await expect(send).resolves.toEqual({
		rejected: true,
		reason: "Session send cancelled.",
	});
	const snapshot = engine.getSnapshot();
	expect(snapshot.turnActive).toBe(false);
	expect(snapshot.executions).toEqual([]);
	expect(snapshot.approvals).toEqual([]);
});

test("interrupts the turn, not the Steering Message it delivered", async () => {
	const accepting = Promise.withResolvers<void>();
	const corrected = Promise.withResolvers<void>();
	const parked = Promise.withResolvers<void>();
	const engine = createEngine([], undefined, {
		runtime: {
			requestOverheadTokens: () => 0,
			run: async ({ callbacks, execution, takeSteeringMessages }) => {
				callbacks.onEvent({
					agentId: execution.agent,
					sequence: 0,
					startedAt: 1,
					turnId: execution.turnId,
					type: "agent-turn-started",
				});
				callbacks.onEvent({
					delta: "Working",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				// The test steers the turn, and the boundary takes what joined it.
				accepting.resolve();
				await corrected.promise;
				takeSteeringMessages();
				await parked.promise;
				return { error: new Error("The Agent Turn was interrupted.") };
			},
		},
	});

	const send = engine.send(sendInput({ userText: "one" }));
	await accepting.promise;
	await engine.send(sendInput({ userText: "correction" }));
	corrected.resolve();
	await Promise.resolve();
	engine.interrupt();
	parked.resolve();
	await send;

	const context = engine.getSnapshot().context;
	const assistant = context.findLast(({ role }) => role === "assistant");
	const steering = context.findLast(({ role }) => role === "user");
	// The turn's own message wears the interruption, and the message that joined
	// it stays in the context as the user message it was delivered as.
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(userPrompts(context)).toContain("correction");
	expect(steering?.metadata?.interrupted).toBeUndefined();
	expect(steering?.metadata?.responseTimeMs).toBeUndefined();
});

test("interrupting a turn keeps the Assistant message it already streamed", async () => {
	const streaming = createStreamingRuntime();
	const engine = createEngine([], undefined, { runtime: streaming.runtime });

	const send = engine.send(sendInput());
	await streaming.live;
	engine.interrupt();
	streaming.release();

	await expect(send).resolves.toEqual({ rejected: false });
	const assistant = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "assistant");
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(assistant?.parts).toContainEqual({
		text: "partial",
		type: "text",
	});
});

test("ends the Agent Turn an aborted approval belongs to", async () => {
	const streaming = createStreamingRuntime();
	const engine = createEngine([], undefined, { runtime: streaming.runtime });

	const send = engine.send(sendInput());
	await streaming.live;
	const settled = engine.requestApproval(
		fromPartial<ToolApprovalRequest>({ toolCallId: toolCallId("call-1") })
	);
	engine.abortApprovalTurn(toolCallId("call-1"));

	await expect(settled).resolves.toEqual({ decision: "reject" });
	streaming.release();
	await send;
	const assistant = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "assistant");
	expect(assistant?.metadata?.interrupted).toBe(true);
});
