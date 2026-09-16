import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentTurnId } from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import {
	createSessionEngine,
	type SessionEngine,
	type SessionViewState,
} from "@/modules/sessions/engine/session-engine";
import type { SessionMessage } from "@/modules/sessions/message";
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
