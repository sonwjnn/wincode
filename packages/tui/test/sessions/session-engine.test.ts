import { expect, mock, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentTurnId,
	createOperationalFailure,
} from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import { createSessionEngine } from "@/modules/sessions/engine/session-engine";
import type {
	SessionEngine,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryTarget,
	SessionOverflowReplayOutcome,
	SessionViewState,
} from "@/modules/sessions/engine/types";
import type { SessionMessage } from "@/modules/sessions/message";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { createHangingSummary } from "../support/hanging-summary";
import {
	agentTurnId,
	compactionId,
	modelId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const compactionSettings = {
	enabled: true,
	keepRecentTokens: 1,
	thresholdTokens: null,
} as const;

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

const createEngine = (
	initialTranscript: readonly SessionMessage[],
	compactionModule = createCompactionModule(async () => ({ text: "summary" }))
): SessionEngine =>
	createSessionEngine({
		compaction: compactionModule,
		initialTranscript,
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

	engine.setStatus("ready");
	expect(engine.getSnapshot()).toBe(initial);
	expect(notifications).toBe(0);

	engine.setStatus("streaming");
	expect(engine.getSnapshot()).not.toBe(initial);
	expect(engine.getSnapshot().status).toBe("streaming");
	expect(notifications).toBe(1);

	unsubscribe();
	engine.setStatus("ready");
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

	engine.setStatus("submitted");

	expect(engine.getSnapshot().status).toBe("submitted");
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
		settings: compactionSettings,
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
		settings: compactionSettings,
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
		settings: compactionSettings,
		trigger: "threshold",
	});
	const joined = engine.compact({
		model,
		settings: compactionSettings,
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
		settings: compactionSettings,
		trigger: "threshold",
	});

	await expect(
		engine.compact({
			focus: "preserve database decisions",
			model,
			settings: compactionSettings,
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
		settings: compactionSettings,
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
		settings: compactionSettings,
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
		settings: compactionSettings,
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

const beginExecutions = (): {
	child: AgentTurnId;
	engine: SessionEngine;
	parent: AgentTurnId;
} => {
	const engine = createEngine([]);
	const parent = agentTurnId("turn-parent");
	const child = agentTurnId("turn-child");
	engine.beginExecution({ startedAt: 1, turnId: parent });
	engine.setExecutionViewState(parent, viewState("turn-parent", "parent text"));
	engine.beginExecution({
		parent: {
			parentToolCallId: toolCallId("call-delegate"),
			parentTurnId: parent,
		},
		startedAt: 2,
		turnId: child,
	});
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
	engine.beginExecution({ startedAt: 1, turnId: root });
	engine.setExecutionViewState(root, viewState("turn-root", "root text"));
	engine.beginExecution({
		parent: { parentToolCallId: toolCallId("call-1"), parentTurnId: root },
		startedAt: 2,
		turnId: first,
	});
	engine.beginExecution({
		parent: { parentToolCallId: toolCallId("call-2"), parentTurnId: root },
		startedAt: 3,
		turnId: second,
	});
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

	engine.shutdown();

	await expect(settled).resolves.toEqual({ decision: "reject" });
	expect(engine.getSnapshot().approvals[0]?.decision).toEqual({
		decision: "reject",
	});
});

test("settles an approval that arrives after the session shut down", async () => {
	const engine = createEngine([]);
	engine.shutdown();

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

const recoveryTarget: SessionOverflowRecoveryTarget = {
	model,
	settings: compactionSettings,
};

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
	engine.beginExecution({ startedAt: 2, turnId: agentTurnId("turn-2") });
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
	engine.beginExecution({ startedAt: 2, turnId: agentTurnId("turn-2") });
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
	engine.beginExecution({
		startedAt: 1,
		turnId: agentTurnId("turn-overflow"),
	});
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
