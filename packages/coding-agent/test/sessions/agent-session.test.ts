import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { SessionMessageId, SessionRecord } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { ResolvedCodingAgent } from "@/modules/agents/built-ins";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import type { ResolvedCompactionSettings } from "@/modules/sessions/compaction/config";
import { compactionSummaryMessageId } from "@/modules/sessions/compaction/summary-message";
import type {
	AppendSessionCompactionInput,
	SummaryGenerator,
} from "@/modules/sessions/compaction/types";
import { AgentSessionImpl } from "@/modules/sessions/engine/agent-session";
import type {
	AgentSessionPorts,
	SessionSkillCatalog,
	SessionSubmissionEvent,
	SessionTurnRequest,
} from "@/modules/sessions/engine/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type {
	SessionSendInput,
	SessionSubmissionComposition,
} from "@/modules/sessions/submission-types";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { createHangingSummary } from "../support/hanging-summary";
import {
	agentId,
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

/** The ports one Agent Session test runs against, unless it overrides them. */
const createPorts = ({
	compaction,
	...overrides
}: Partial<AgentSessionPorts> & {
	compaction: AgentSessionPorts["compaction"];
}): AgentSessionPorts => ({
	attachments: {
		externalize: async (messages) => [...messages],
		hydrate: async ({ messages }) => [...messages],
		release: () => undefined,
		retain: () => undefined,
	},
	commitRecord: async () => undefined,
	resolveSubmission: (input) => input,
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
	turnRunner: {
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

const createTestAgentSession = (
	initialTranscript: readonly SessionMessage[],
	compactionModule = createCompactionModule(async () => ({ text: "summary" })),
	overrides: Partial<AgentSessionPorts> = {}
): AgentSessionImpl =>
	new AgentSessionImpl({
		initialTranscript,
		ports: createPorts({ compaction: compactionModule, ...overrides }),
		sessionId: sessionId("agent-session-test"),
	});

test("publishes snapshots only when public commands change session facts", async () => {
	const engine = createTestAgentSession([]);
	const initial = engine.getSnapshot();
	let notifications = 0;
	const unsubscribe = engine.subscribe(() => {
		notifications += 1;
	});

	expect(engine.interruptAll()).toMatchObject({
		approvalsSettled: 0,
		kind: "none",
		recalled: [],
	});
	expect(engine.getSnapshot()).toBe(initial);
	expect(notifications).toBe(0);

	await engine.send(sendInput({ userText: "first prompt" }));
	const changed = engine.getSnapshot();
	expect(changed).not.toBe(initial);
	expect(notifications).toBeGreaterThan(0);

	unsubscribe();
	const settledNotifications = notifications;
	await engine.send(sendInput({ userText: "second prompt" }));
	expect(notifications).toBe(settledNotifications);
});

test("isolates a failing observer from public session commands and other observers", async () => {
	const engine = createTestAgentSession([]);
	let observed = 0;
	engine.subscribe(() => {
		throw new Error("observer failed");
	});
	engine.subscribe(() => {
		observed += 1;
	});

	await engine.send(sendInput({ userText: "observer-safe prompt" }));

	expect(userPrompts(engine.getSnapshot().context)).toContain(
		"observer-safe prompt"
	);
	expect(observed).toBeGreaterThan(0);
});

test("runs a compaction command and publishes what it produced", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
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

test("starts queued work only after compaction publishes its new Context", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const receivedMessages = Promise.withResolvers<readonly SessionMessage[]>();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async ({ messages }) => {
					receivedMessages.resolve(messages);
					return {};
				},
			},
		}
	);
	const compaction = engine.compact({ model, trigger: "threshold" });
	const admission = await engine.prompt(
		sendInput({ userText: "after compaction" })
	);

	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	release();
	await compaction;
	const received = await receivedMessages.promise;

	expect(engine.getSnapshot().isCompacting).toBe(false);
	expect(received.map(({ id }) => id)).toContain(
		compactionSummaryMessageId(compactionId("entry-compacted"))
	);
	expect(userPrompts(received)).toContain("after compaction");
	await engine.internalPort.shutdown();
});

test("settles a joined command only after the swap it joins has landed", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
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
	const engine = createTestAgentSession(
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
	const engine = createTestAgentSession(
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

test("interruptAll settles idle approvals and reports no stopped work", async () => {
	const engine = createTestAgentSession([]);
	const approval = engine.internalPort.requestApproval(
		fromPartial<ToolApprovalRequest>({
			toolCallId: toolCallId("idle-approval"),
		})
	);

	expect(engine.interruptAll()).toMatchObject({
		approvalsSettled: 1,
		kind: "none",
		recalled: [],
	});
	await expect(approval).resolves.toEqual({ decision: "reject" });
});

test("interruptAll aborts compaction and recalls queued submissions", async () => {
	const engine = createTestAgentSession(
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

	const compaction = engine.compact({ model, trigger: "manual" });
	await engine.send(sendInput({ userText: "waiting" }));

	const result = engine.interruptAll();

	expect(result.kind).toBe("compaction");
	expect(result.approvalsSettled).toBe(0);
	expect(result.recalled.map(({ input }) => input.composition.text)).toEqual([
		"waiting",
	]);
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	expect(engine.getSnapshot().isCompacting).toBe(false);
});

test("merges a command's own transcript update before compacting", async () => {
	const engine = createTestAgentSession(compactionHistory());

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
	const engine = createTestAgentSession([message("a9", "unrelated")]);

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

const approvalRequest = (callId?: string): ToolApprovalRequest => ({
	description: "Write denied by policy: src/index.ts",
	identity: [{ label: "tool", value: "write" }],
	input: { path: "src/index.ts" },
	...(callId === undefined ? {} : { toolCallId: toolCallId(callId) }),
});

test("publishes a pending approval and settles it exactly once", async () => {
	const engine = createTestAgentSession([]);
	const settled = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);

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

	// A second trigger cannot settle a request the Agent Session already settled.
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
test("keeps a safety approval pending when persistence is requested", async () => {
	const engine = createTestAgentSession([]);
	const settled = engine.internalPort.requestApproval({
		...approvalRequest("call-safety"),
		safety: true,
	});

	expect(
		engine.respondToApproval("call-safety", {
			decision: "allow",
			remember: true,
		})
	).toEqual({
		applied: false,
		reason: "persistence-forbidden",
	});
	expect(engine.getSnapshot().approvals[0]?.decision).toBeUndefined();

	engine.respondToApproval("call-safety", {
		decision: "allow",
		remember: false,
	});
	await expect(settled).resolves.toEqual({
		decision: "allow",
		remember: false,
	});
});
test("aborts the active turn through an approval response", async () => {
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});
	const send = engine.send(sendInput());

	await streaming.live;
	const settled = engine.internalPort.requestApproval(
		approvalRequest("call-abort")
	);

	expect(engine.respondToApproval("call-abort", { decision: "abort" })).toEqual(
		{ applied: true }
	);
	await expect(settled).resolves.toEqual({ decision: "abort" });
	expect(engine.getSnapshot().turnActive).toBe(false);

	streaming.release();
	await send;
	expect(
		engine.getSnapshot().context.findLast(({ role }) => role === "assistant")
			?.metadata?.interrupted
	).toBe(true);
});

test("gives a Tool-Call-less approval its own id and settles it with every sibling", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest());
	const second = engine.internalPort.requestApproval(approvalRequest());
	const [firstEntry, secondEntry] = engine.getSnapshot().approvals;

	expect(firstEntry?.target).toBe("session");
	expect(firstEntry?.id).toBeString();
	expect(firstEntry?.id).not.toBe(secondEntry?.id);

	engine.interruptAll();
	await expect(first).resolves.toEqual({ decision: "reject" });
	await expect(second).resolves.toEqual({ decision: "reject" });
});

test("interruptAll settles every pending approval", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest("call-1"));
	const second = engine.internalPort.requestApproval(approvalRequest("call-2"));

	engine.interruptAll();

	await expect(first).resolves.toEqual({ decision: "reject" });
	await expect(second).resolves.toEqual({ decision: "reject" });
	expect(
		engine.getSnapshot().approvals.map(({ decision }) => decision)
	).toEqual([{ decision: "reject" }, { decision: "reject" }]);
});

test("refuses a second pending request that reuses a Tool Call Identifier", async () => {
	const engine = createTestAgentSession([]);
	const first = engine.internalPort.requestApproval(approvalRequest("call-1"));
	const duplicate = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);

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
	const engine = createTestAgentSession([]);
	const aborted = engine.internalPort.requestApproval(
		approvalRequest("call-1")
	);
	const sibling = engine.internalPort.requestApproval(
		approvalRequest("call-2")
	);

	engine.respondToApproval("call-1", { decision: "abort" });
	engine.interruptAll();

	await expect(aborted).resolves.toEqual({ decision: "abort" });
	await expect(sibling).resolves.toEqual({ decision: "reject" });
});

/** The provider's public context-window refusal. */
const overflowFailure = (): Error =>
	new Error("This model's maximum context length is 128000 tokens.");
const overflowRecoverySettings = (): ResolvedCompactionSettings =>
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
	});

const reportTurnStarted = ({
	callbacks,
	execution,
}: SessionTurnRequest): void => {
	callbacks.onEvent({
		agentId: execution.agent,
		sequence: 0,
		startedAt: 1,
		turnId: execution.turnId,
		type: "agent-turn-started",
	});
};

const completeRuntimeTurn = async ({
	callbacks,
	execution,
}: SessionTurnRequest): Promise<void> => {
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
};

const overflowTurnRunner: AgentSessionPorts["turnRunner"] = {
	requestOverheadTokens: () => 0,
	run: async (request) => {
		reportTurnStarted(request);
		return { error: overflowFailure() };
	},
};

const createOverflowTestSession = (
	initialTranscript: readonly SessionMessage[] = [],
	overrides: Partial<AgentSessionPorts> = {},
	summaryGenerator: SummaryGenerator = async () => ({ text: "summary" })
): AgentSessionImpl =>
	createTestAgentSession(
		initialTranscript,
		createCompactionModule(summaryGenerator),
		{
			resolveCompactionSettings: async () => overflowRecoverySettings(),
			turnRunner: overflowTurnRunner,
			...overrides,
		}
	);

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
	readonly runtime: AgentSessionPorts["turnRunner"];
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

test("keeps admission identities across a Steering delivery lifecycle", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const events: SessionSubmissionEvent[] = [];
	const delivered = Promise.withResolvers<void>();
	engine.onSubmissionEvent((event) => {
		events.push(event);
		if (event.kind === "delivered") {
			delivered.resolve();
		}
	});

	const started = await engine.prompt(sendInput({ userText: "one" }));
	if (started.rejected) {
		throw new Error(started.reason);
	}
	await runtime.started(1);

	const steering = engine.steer("correction");
	if (steering.rejected) {
		throw new Error(steering.reason);
	}
	expect(steering.disposition).toBe("steering");
	expect(steering.submissionId).not.toBe(started.submissionId);
	expect(steering.messageId).not.toBe(started.messageId);
	expect(events).toEqual([
		{
			kind: "started",
			messageId: started.messageId,
			submissionId: started.submissionId,
			turnId: started.turnId,
		},
	]);

	runtime.release();
	await delivered.promise;
	await engine.internalPort.shutdown();

	expect(events).toEqual([
		{
			kind: "started",
			messageId: started.messageId,
			submissionId: started.submissionId,
			turnId: started.turnId,
		},
		{
			kind: "delivered",
			messageId: steering.messageId,
			submissionId: steering.submissionId,
			turnId: steering.turnId,
		},
	]);
});

test("prompt queues a second submission instead of steering a live turn", async () => {
	const runtime = createQueuedRuntime({ boundary: true });
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const started = await engine.prompt(sendInput({ userText: "first" }));
	if (started.rejected) {
		throw new Error(started.reason);
	}
	await runtime.started(1);

	const files: SessionFilePart[] = [
		fromPartial<SessionFilePart>({
			attachmentId: attachmentId("queued-file"),
			mediaType: "image/png",
			type: "file",
			url: "attachment://queued-file",
		}),
	];
	const composition = compositionOf("second with file", files);
	const queued = await engine.prompt(
		sendInput({
			composition,
			files,
			userText: "second with file",
		})
	);

	expect(queued).toMatchObject({ rejected: false, disposition: "queued" });
	expect(engine.getSnapshot().steeringMessages).toEqual([]);
	expect(engine.getSnapshot().queuedSubmissions[0]?.input.composition).toEqual(
		composition
	);
	expect(engine.continue().kind).toBe("rejected");

	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["first", "second with file"]);
	runtime.release();
	await engine.internalPort.shutdown();
});

test("compatibility send queues while the active submission is still preparing", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
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
		turnRunner: runtime.runtime,
	});
	const files: SessionFilePart[] = [
		{
			filename: "first.txt",
			mediaType: "text/plain",
			type: "file",
			url: "data:text/plain;base64,QQ==",
		},
	];
	const started = await engine.prompt(sendInput({ files, userText: "first" }));
	if (started.rejected) {
		throw new Error(started.reason);
	}
	await externalizeStarted.promise;

	const queued = await engine.send(sendInput({ userText: "second" }));
	const preparingSnapshot = engine.getSnapshot();

	expect(queued).toEqual({ rejected: false });
	expect(preparingSnapshot.turnActive).toBe(true);
	expect(
		preparingSnapshot.queuedSubmissions.map(
			({ input }) => input.composition.text
		)
	).toEqual(["second"]);
	expect(runtime.prompts).toEqual([]);

	allowExternalize.resolve();
	await runtime.started(1);
	expect(runtime.prompts).toEqual(["first"]);
	runtime.release();
	await runtime.started(2);
	expect(runtime.prompts).toEqual(["first", "second"]);
	runtime.release();
	await engine.internalPort.shutdown();
});

test("admits queued attachment prompts before externalization finishes in FIFO order", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
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
			turnRunner: runtime.runtime,
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
	const firstAdmissionPromise = engine.prompt(
		sendInput({
			composition: compositionOf("first with file", files),
			files,
			userText: "first with file",
		})
	);
	await externalizeStarted.promise;
	let firstAdmissionResolved = false;
	void firstAdmissionPromise.then(() => {
		firstAdmissionResolved = true;
	});
	await Promise.resolve();
	const admittedBeforeExternalization = firstAdmissionResolved;
	const secondAdmission = await engine.prompt(
		sendInput({ userText: "second" })
	);
	const queuedOrderBeforeExternalization = engine
		.getSnapshot()
		.queuedSubmissions.map(({ input }) => input.composition.text);

	allowExternalize.resolve();
	await firstAdmissionPromise;
	release();
	await compaction;
	await runtime.started(1);
	const firstStartedPrompt = runtime.prompts[0];
	runtime.release();
	await runtime.started(2);
	const secondStartedPrompt = runtime.prompts[1];
	runtime.release();
	await engine.internalPort.shutdown();

	expect(admittedBeforeExternalization).toBe(true);
	expect(secondAdmission).toMatchObject({
		disposition: "queued",
		rejected: false,
	});
	expect(queuedOrderBeforeExternalization).toEqual([
		"first with file",
		"second",
	]);
	expect(firstStartedPrompt).toBe("first with file");
	expect(secondStartedPrompt).toBe("second");
});

test("interruptAll recalls queued attachments before externalization completes", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const allowExternalize = Promise.withResolvers<void>();
	let externalizeSignal: AbortSignal | undefined;
	const engine = createTestAgentSession(
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
		}),
		{
			attachments: {
				externalize: async (messages, signal) => {
					externalizeSignal = signal;
					externalizeStarted.resolve();
					await allowExternalize.promise;
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
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
	const admissionPromise = engine.prompt(
		sendInput({
			composition: compositionOf("waiting", files),
			files,
			userText: "waiting",
		})
	);
	await externalizeStarted.promise;
	const interrupted = engine.interruptAll();
	const externalizationAborted = externalizeSignal?.aborted ?? false;
	const queueAfterInterrupt = engine.getSnapshot().queuedSubmissions;

	allowExternalize.resolve();
	const admission = await admissionPromise;
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await engine.internalPort.shutdown();

	expect(admission).toMatchObject({ disposition: "queued", rejected: false });
	expect(
		interrupted.recalled.map(({ input }) => input.composition.text)
	).toEqual(["waiting"]);
	expect(externalizationAborted).toBe(true);
	expect(queueAfterInterrupt).toEqual([]);
});

test("continue resumes the last user context without appending another prompt", async () => {
	const runtime = createQueuedRuntime();
	const refreshedModel: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna-pro"),
		providerId: "openai",
	};
	const stored = fromPartial<SessionMessage>({
		id: sessionMessageId("u-continue"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "continue me", type: "text" }],
		role: "user",
	});
	const resolvedInputs: SessionSendInput[] = [];
	const engine = createTestAgentSession([stored], undefined, {
		resolveSubmission: (input) => {
			resolvedInputs.push(input);
			return {
				...input,
				model: refreshedModel,
				resolvedAgent: sendInput().resolvedAgent,
			};
		},
		turnRunner: runtime.runtime,
	});

	const outcome = engine.continue();
	expect(outcome.kind).toBe("resumed");
	await runtime.started(1);

	expect(runtime.prompts).toEqual(["continue me"]);
	expect(runtime.targets).toEqual([
		{ model: refreshedModel, variant: undefined },
	]);
	expect(resolvedInputs).toHaveLength(1);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([stored]);
	runtime.release();
	await engine.internalPort.shutdown();
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([stored]);
});

test("continue retains completed Tool Calls as context without rerunning them", async () => {
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-tool-context"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "inspect this", type: "text" }],
		role: "user",
	});
	const toolMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("a-tool-context"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				input: { path: "file.txt" },
				output: { text: "contents" },
				state: "output-available",
				toolCallId: toolCallId("call-complete"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const messagesSeen: SessionMessage[][] = [];
	const completed = Promise.withResolvers<void>();
	const answer = answeringRuntime();
	const engine = createTestAgentSession([user, toolMessage], undefined, {
		resolveSubmission: (input) => ({
			...input,
			resolvedAgent: sendInput().resolvedAgent,
		}),
		turnRunner: {
			requestOverheadTokens: answer.requestOverheadTokens,
			run: async (request) => {
				messagesSeen.push([...request.messages]);
				const outcome = await answer.run(request);
				completed.resolve();
				return outcome;
			},
		},
	});

	expect(engine.continue().kind).toBe("resumed");
	await completed.promise;
	await engine.internalPort.shutdown();

	expect(messagesSeen).toEqual([[user, toolMessage]]);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([user]);
	expect(
		engine
			.getSnapshot()
			.context.flatMap(({ parts }) =>
				parts.filter(
					(part) =>
						"type" in part &&
						part.type === "tool-read" &&
						"toolCallId" in part &&
						part.toolCallId === toolCallId("call-complete")
				)
			)
	).toHaveLength(1);
});
test("continue resumes retained denied Tool Calls without rerunning them", async () => {
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-denied-context"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "run a protected tool", type: "text" }],
		role: "user",
	});
	const toolMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("a-denied-context"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				approval: { approved: false },
				input: { path: "secret.txt" },
				state: "output-denied",
				toolCallId: toolCallId("call-denied"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const messagesSeen: SessionMessage[][] = [];
	const completed = Promise.withResolvers<void>();
	const answer = answeringRuntime();
	const engine = createTestAgentSession([user, toolMessage], undefined, {
		resolveSubmission: (input) => ({
			...input,
			resolvedAgent: sendInput().resolvedAgent,
		}),
		turnRunner: {
			requestOverheadTokens: answer.requestOverheadTokens,
			run: async (request) => {
				messagesSeen.push([...request.messages]);
				const outcome = await answer.run(request);
				completed.resolve();
				return outcome;
			},
		},
	});

	expect(engine.continue().kind).toBe("resumed");
	await completed.promise;
	await engine.internalPort.shutdown();

	expect(messagesSeen).toEqual([[user, toolMessage]]);
	expect(
		engine.getSnapshot().context.filter(({ role }) => role === "user")
	).toEqual([user]);
	expect(
		engine
			.getSnapshot()
			.context.flatMap(({ parts }) =>
				parts.filter(
					(part) =>
						"type" in part &&
						part.type === "tool-read" &&
						"toolCallId" in part &&
						part.toolCallId === toolCallId("call-denied")
				)
			)
	).toHaveLength(1);
});

test("continue rejects incomplete Tool Calls even when a later user is last", async () => {
	let runtimeStarts = 0;
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u-incomplete"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "run a tool", type: "text" }],
		role: "user",
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a-incomplete"),
		metadata: {
			agent: agentId("build"),
			model,
			sourceUserMessageId: user.id,
		},
		parts: [
			{
				input: { path: "file.txt" },
				state: "input-available",
				toolCallId: toolCallId("call-incomplete"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});
	const laterUser = fromPartial<SessionMessage>({
		id: sessionMessageId("u-after-incomplete"),
		metadata: { agent: agentId("build"), model },
		parts: [{ text: "continue anyway", type: "text" }],
		role: "user",
	});
	const engine = createTestAgentSession(
		[user, assistant, laterUser],
		undefined,
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async () => {
					runtimeStarts += 1;
					return {};
				},
			},
		}
	);

	expect(engine.continue()).toMatchObject({ kind: "rejected" });
	expect(runtimeStarts).toBe(0);
	await engine.internalPort.shutdown();
});

test("starts a queued admission with the identity it reserved", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
	);
	const events: SessionSubmissionEvent[] = [];
	engine.onSubmissionEvent((event) => events.push(event));

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = await engine.prompt(sendInput({ userText: "queued" }));
	if (queued.rejected) {
		throw new Error(queued.reason);
	}
	expect(queued.disposition).toBe("queued");
	expect(events).toEqual([]);

	release();
	await compaction;
	await runtime.started(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		kind: "started",
		messageId: queued.messageId,
		submissionId: queued.submissionId,
	});
	expect(events[0]?.turnId).toBeDefined();
	runtime.release();
	await engine.internalPort.shutdown();
});

test("recalls a queued admission before it creates a Session Record", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator)
	);
	const events: SessionSubmissionEvent[] = [];
	engine.onSubmissionEvent((event) => events.push(event));

	const compaction = engine.compact({ model, trigger: "manual" });
	const queued = await engine.prompt(sendInput({ userText: "withdraw me" }));
	if (queued.rejected) {
		throw new Error(queued.reason);
	}
	const recalled = engine.recallWaitingMessages([queued.submissionId]);

	expect(recalled).toHaveLength(1);
	const recalledQueued = recalled[0];
	if (recalledQueued === undefined || !("submissionId" in recalledQueued)) {
		throw new Error("The queued submission was not recalled.");
	}
	expect(recalledQueued.submissionId).toBe(queued.submissionId);
	expect(recalledQueued.messageId).toBe(queued.messageId);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		kind: "recalled",
		messageId: queued.messageId,
		reason: "recall",
		submissionId: queued.submissionId,
	});
	expect(events[0]?.turnId).toBeDefined();
	expect(userPrompts(engine.getSnapshot().transcript)).not.toContain(
		"withdraw me"
	);

	release();
	await compaction;
	await engine.internalPort.shutdown();
});

test("queues a submission that arrives while a compaction is in flight", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: runtime.runtime,
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
	const engine = createTestAgentSession([], undefined, {
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
		turnRunner: runtime.runtime,
	});

	const first = engine.send(sendInput({ userText: "one" }));
	await runtime.started(1);
	await engine.send(sendInput({ userText: "correction" }));
	runtime.release();
	await commitStarted.promise;
	await first;

	const shutdown = engine.internalPort.shutdown();
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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

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
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: runtime.runtime,
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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
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

test("hands a fallback Steering Message ahead of later queued work", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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

	// Steering that missed its delivery boundary becomes the next submission;
	// it does not overtake the older queued prompt.
	expect(runtime.prompts).toEqual(["queued-first", "steer", "queued-second"]);
	runtime.release();
});

test("refuses a Steering Message that invokes a Skill or resends another message", async () => {
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});

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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{ turnRunner: runtime.runtime }
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

test("steers the Agent Turn started by overflow context continuation", async () => {
	const gates: Array<() => void> = [];
	const prompts: string[] = [];
	const delivered: string[][] = [];
	const continuationStarted = Promise.withResolvers<void>();
	const engine = createTestAgentSession(compactionHistory(), undefined, {
		resolveCompactionSettings: async () => overflowRecoverySettings(),
		turnRunner: {
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
				continuationStarted.resolve();
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
	// Recovery continues from the compacted Session Context; it does not add
	// another user message to the Submission Queue or Transcript.
	await continuationStarted.promise;
	const accepted = await engine.send(sendInput({ userText: "second" }));

	// The context continuation is the Agent Turn the session is running, so the
	// submission joins its Steering Lane instead of waiting for it to end.
	expect(accepted).toEqual({ rejected: false });
	expect(
		engine.getSnapshot().steeringMessages.map(({ input }) => input.text)
	).toEqual(["second"]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);

	gates.shift()?.();
	await send;
	// The continuation delivers the correction at its Model Step boundary.
	expect(delivered).toEqual([["second"]]);
	expect(prompts).toEqual(["first", "first"]);
	expect(userPrompts(engine.getSnapshot().transcript).at(-1)).toBe("second");
});

test("does not recover a context overflow after a completed Tool Call", async () => {
	const toolId = toolCallId("overflow-completed-tool");
	let turnStarted = false;
	let recoveryTargetRequested = false;
	const engine = createOverflowTestSession([], {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				recoveryTargetRequested = true;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			...overflowTurnRunner,
			run: async (request) => {
				turnStarted = true;
				reportTurnStarted(request);
				request.callbacks.onEvent({
					input: { path: "file.txt" },
					sequence: 1,
					toolCallId: toolId,
					toolName: "read",
					turnId: request.execution.turnId,
					type: "tool-call-started",
				});
				request.callbacks.onEvent({
					outcome: {
						output: { content: "completed side effect" },
						type: "success",
					},
					sequence: 2,
					toolCallId: toolId,
					toolName: "read",
					turnId: request.execution.turnId,
					type: "tool-call-finished",
				});
				return { error: overflowFailure() };
			},
		},
	});

	await expect(
		engine.send(sendInput({ userText: "read a file" }))
	).resolves.toEqual({ rejected: false });

	const completedTool = engine
		.getSnapshot()
		.context.flatMap(({ parts }) => parts)
		.find((part) => part.type === "tool-read" && part.toolCallId === toolId);
	expect(completedTool).toMatchObject({
		state: "output-available",
		toolCallId: toolId,
	});
	expect(recoveryTargetRequested).toBe(false);
	expect(engine.getSnapshot().compactions).toEqual([]);
	await engine.internalPort.shutdown();
});

test("does not run overflow recovery for an unrelated runtime failure", async () => {
	let turnStarted = false;
	let recoveryTargetRequested = false;
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				recoveryTargetRequested = true;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			...overflowTurnRunner,
			run: async (request) => {
				turnStarted = true;
				reportTurnStarted(request);
				return { error: new Error("authentication failed") };
			},
		},
	});

	await expect(
		engine.send(sendInput({ userText: "original request" }))
	).resolves.toEqual({ rejected: false });

	expect(engine.getSnapshot().error?.message).toBe("authentication failed");
	expect(recoveryTargetRequested).toBe(false);
	expect(engine.getSnapshot().compactions).toEqual([]);
	await engine.internalPort.shutdown();
});
test("keeps an overflow retryable when recovery is unavailable for its target", async () => {
	const continuationStarted = Promise.withResolvers<void>();
	const allowContinuation = Promise.withResolvers<void>();
	let recoveryAvailable = false;
	let runCount = 0;
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => ({
			...overflowRecoverySettings(),
			overflowRecoveryAvailable: recoveryAvailable,
		}),
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				reportTurnStarted(request);
				if (runCount < 3) {
					return { error: overflowFailure() };
				}
				continuationStarted.resolve();
				await allowContinuation.promise;
				await completeRuntimeTurn(request);
				return {};
			},
		},
	});

	try {
		await engine.send(sendInput({ userText: "original request" }));
		const originalMessage = engine
			.getSnapshot()
			.context.findLast(({ role }) => role === "user");
		if (originalMessage === undefined) {
			throw new Error("The first prompt was not stored.");
		}
		expect(engine.getSnapshot().compactions).toEqual([]);

		recoveryAvailable = true;
		await engine.send(
			sendInput({ messageId: originalMessage.id, userText: undefined })
		);
		await continuationStarted.promise;

		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);
	} finally {
		allowContinuation.resolve();
		await engine.internalPort.shutdown();
	}
});
test("does not retry an overflow recovery that overflows during continuation", async () => {
	const continuationStarted = Promise.withResolvers<void>();
	const allowContinuation = Promise.withResolvers<void>();
	const queuedTurnStarted = Promise.withResolvers<void>();
	const allowQueuedTurn = Promise.withResolvers<void>();
	const prompts: string[] = [];
	let runCount = 0;
	const engine = createOverflowTestSession(compactionHistory(), {
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				prompts.push(promptOfTurn(request.messages));
				reportTurnStarted(request);
				if (runCount === 1) {
					return { error: overflowFailure() };
				}
				if (runCount === 2) {
					continuationStarted.resolve();
					await allowContinuation.promise;
					return { error: overflowFailure() };
				}
				queuedTurnStarted.resolve();
				await allowQueuedTurn.promise;
				await completeRuntimeTurn(request);
				return {};
			},
		},
	});
	const firstSend = engine.send(sendInput({ userText: "original request" }));

	try {
		await continuationStarted.promise;
		await expect(
			engine.send(sendInput({ userText: "next request" }))
		).resolves.toEqual({ rejected: false });
		allowContinuation.resolve();
		await queuedTurnStarted.promise;

		expect(prompts).toEqual([
			"original request",
			"original request",
			"next request",
		]);
		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);
		await firstSend;
	} finally {
		allowContinuation.resolve();
		allowQueuedTurn.resolve();
		await engine.internalPort.shutdown();
	}
});

test("interrupting overflow target resolution prevents recovery compaction", async () => {
	const targetResolutionStarted = Promise.withResolvers<void>();
	const allowTargetResolution = Promise.withResolvers<void>();
	const nextTurnStarted = Promise.withResolvers<void>();
	let turnStarted = false;
	let runCount = 0;
	const prompts: string[] = [];
	const engine = createOverflowTestSession(compactionHistory(), {
		resolveCompactionSettings: async () => {
			if (turnStarted) {
				targetResolutionStarted.resolve();
				await allowTargetResolution.promise;
			}
			return overflowRecoverySettings();
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				runCount += 1;
				prompts.push(promptOfTurn(request.messages));
				reportTurnStarted(request);
				if (runCount === 1) {
					turnStarted = true;
					return { error: overflowFailure() };
				}
				nextTurnStarted.resolve();
				await completeRuntimeTurn(request);
				return {};
			},
		},
	});

	try {
		await engine.send(sendInput({ userText: "original request" }));
		await targetResolutionStarted.promise;

		expect(engine.interruptAll()).toMatchObject({ kind: "turn" });
		await engine.send(sendInput({ userText: "next request" }));
		allowTargetResolution.resolve();
		await nextTurnStarted.promise;

		expect(prompts).toEqual(["original request", "next request"]);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(runCount).toBe(2);
	} finally {
		allowTargetResolution.resolve();
		await engine.internalPort.shutdown();
	}
});

test("interrupting overflow recovery compaction prevents context continuation", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const summaryStarted = Promise.withResolvers<void>();
	const compactionStopped = Promise.withResolvers<void>();
	let recoveryCompactionStarted = false;
	let runCount = 0;
	const delayedSummary: SummaryGenerator = async (input) => {
		summaryStarted.resolve();
		return summaryGenerator(input);
	};
	const engine = createOverflowTestSession(
		compactionHistory(),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					runCount += 1;
					reportTurnStarted(request);
					return { error: overflowFailure() };
				},
			},
		},
		delayedSummary
	);
	const unsubscribe = engine.subscribe(() => {
		if (engine.getSnapshot().isCompacting) {
			recoveryCompactionStarted = true;
		} else if (recoveryCompactionStarted) {
			compactionStopped.resolve();
		}
	});

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		await summaryStarted.promise;
		expect(engine.interruptAll()).toMatchObject({ kind: "compaction" });
		release();
		await compactionStopped.promise;

		expect(runCount).toBe(1);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(engine.getSnapshot().compactionError).toBeNull();
	} finally {
		unsubscribe();
		release();
		await engine.internalPort.shutdown();
	}
});

test("shutdown prevents overflow recovery from continuing after compaction", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const summaryStarted = Promise.withResolvers<void>();
	let runCount = 0;
	const delayedSummary: SummaryGenerator = async (input) => {
		summaryStarted.resolve();
		return summaryGenerator(input);
	};
	const engine = createOverflowTestSession(
		compactionHistory(),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					runCount += 1;
					reportTurnStarted(request);
					return { error: overflowFailure() };
				},
			},
		},
		delayedSummary
	);

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		await summaryStarted.promise;
		const shutdown = engine.internalPort.shutdown();
		release();
		await shutdown;

		expect(runCount).toBe(1);
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(engine.getSnapshot().compactionError).toBeNull();
	} finally {
		release();
		await engine.internalPort.shutdown();
	}
});

test("refuses overflow continuation while a public compaction is active", async () => {
	const recoverySummaryStarted = Promise.withResolvers<void>();
	const allowRecoverySummary = Promise.withResolvers<void>();
	const manualSummaryStarted = Promise.withResolvers<void>();
	const allowManualSummary = Promise.withResolvers<void>();
	const continuationRefused = Promise.withResolvers<Error>();
	let summaryCount = 0;
	let manualCompactionStarted = false;
	let manualCompaction: Promise<unknown> | undefined;
	const summaryGenerator: SummaryGenerator = async () => {
		summaryCount += 1;
		if (summaryCount === 1) {
			recoverySummaryStarted.resolve();
			await allowRecoverySummary.promise;
			return { text: "overflow summary" };
		}
		if (summaryCount === 2) {
			manualSummaryStarted.resolve();
			await allowManualSummary.promise;
			return { text: "manual summary" };
		}
		throw new Error("Unexpected extra compaction.");
	};
	const engine = createOverflowTestSession(
		compactionHistory(),
		{},
		summaryGenerator
	);
	const unsubscribe = engine.subscribe(() => {
		const snapshot = engine.getSnapshot();
		if (
			!snapshot.isCompacting &&
			snapshot.compactions.some(({ trigger }) => trigger === "overflow") &&
			!manualCompactionStarted
		) {
			manualCompactionStarted = true;
			manualCompaction = engine.compact({ model, trigger: "manual" });
		}
		const error = snapshot.compactionError;
		if (
			error?.message.includes(
				"could not continue the compacted Session Context"
			)
		) {
			continuationRefused.resolve(error);
		}
	});

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		await recoverySummaryStarted.promise;
		allowRecoverySummary.resolve();
		await manualSummaryStarted.promise;
		const error = await continuationRefused.promise;

		expect(error).toMatchObject({ code: "continuation-refused" });
		expect(engine.getSnapshot().isCompacting).toBe(true);
		expect(
			engine.getSnapshot().compactions.map(({ trigger }) => trigger)
		).toEqual(["overflow"]);

		allowManualSummary.resolve();
		if (manualCompaction === undefined) {
			throw new Error("The competing compaction did not start.");
		}
		await manualCompaction;
		expect(summaryCount).toBe(2);
	} finally {
		unsubscribe();
		allowRecoverySummary.resolve();
		allowManualSummary.resolve();
		await manualCompaction?.catch(() => undefined);
		await engine.internalPort.shutdown();
	}
});
test("reports a failed overflow compaction without starting a continuation", async () => {
	const compactionError = Promise.withResolvers<Error>();
	let runCount = 0;
	const engine = createOverflowTestSession(
		compactionHistory(),
		{
			turnRunner: {
				requestOverheadTokens: () => 0,
				run: async (request) => {
					runCount += 1;
					reportTurnStarted(request);
					return { error: overflowFailure() };
				},
			},
		},
		async () => {
			throw new Error("summary generation failed");
		}
	);
	const unsubscribe = engine.subscribe(() => {
		const error = engine.getSnapshot().compactionError;
		if (error !== null) {
			compactionError.resolve(error);
		}
	});

	try {
		await engine.send(sendInput({ userText: "overflowing request" }));
		const failure = await compactionError.promise;

		expect(failure.message).toContain("could not compact the session");
		expect(engine.getSnapshot().compactions).toEqual([]);
		expect(runCount).toBe(1);
	} finally {
		unsubscribe();
		await engine.internalPort.shutdown();
	}
});

test("retains a queued submission's attachments until its turn runs", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const retained: string[][] = [];
	const released: string[][] = [];
	const holdEnded = Promise.withResolvers<void>();
	const engine = createTestAgentSession(
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
			turnRunner: runtime.runtime,
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
	const engine = createTestAgentSession(
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
			turnRunner: runtime.runtime,
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
	const shutdown = engine.internalPort.shutdown();
	release();
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });

	const probe = Promise.withResolvers<"probe">();
	const shutdownSettled = shutdown.then(() => "shutdown" as const);
	const result = Promise.race([shutdownSettled, probe.promise]);
	queueMicrotask(() => probe.resolve("probe"));
	expect(await result).toBe("probe");

	allowExternalize.resolve();
	await expect(queued).resolves.toMatchObject({
		rejected: true,
		reason: "The session has ended.",
	});
	await shutdown;
});

test("refuses a submission that carries attachments into a running turn", async () => {
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
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
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
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

	const shutdown = engine.internalPort.shutdown();

	expect(released).toEqual([["dropped-blob"]]);
	expect(engine.getSnapshot().queuedSubmissions).toEqual([]);
	release();
	await expect(compaction).rejects.toMatchObject({ code: "cancelled" });
	await shutdown;
});

test("refuses a submission once the session has shut down", async () => {
	const engine = createTestAgentSession([]);
	await engine.internalPort.shutdown();

	await expect(engine.send(sendInput())).resolves.toEqual({
		rejected: true,
		reason: "The session has ended.",
	});
});
test("ignores runtime callbacks that arrive after shutdown", async () => {
	const runtime = createQueuedRuntime();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: runtime.runtime,
	});
	const send = engine.send(sendInput());
	await runtime.started(1);

	const shutdown = engine.internalPort.shutdown();
	const snapshotAtShutdown = engine.getSnapshot();
	runtime.release();
	await shutdown;
	await send;

	expect(engine.getSnapshot().context).toEqual(snapshotAtShutdown.context);
	expect(engine.getSnapshot().transcript).toEqual(
		snapshotAtShutdown.transcript
	);
	expect(engine.getSnapshot().viewState).toEqual(snapshotAtShutdown.viewState);
});

test("releases a recalled submission's attachment hold", async () => {
	const { release, summaryGenerator } = createHangingSummary();
	const runtime = createQueuedRuntime();
	const released: string[][] = [];
	const engine = createTestAgentSession(
		compactionHistory(),
		createCompactionModule(summaryGenerator),
		{
			attachments: {
				externalize: async (messages) => [...messages],
				hydrate: async ({ messages }) => [...messages],
				release: (attachmentIds) => released.push([...attachmentIds]),
				retain: () => undefined,
			},
			turnRunner: runtime.runtime,
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
const answeringRuntime = (): AgentSessionPorts["turnRunner"] => ({
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
	readonly runtime: AgentSessionPorts["turnRunner"];
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
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: answeringRuntime(),
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

test("ignores late provider callbacks after local interruption", async () => {
	const live = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
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
					delta: "before interruption",
					sequence: 1,
					turnId: execution.turnId,
					type: "text-delta",
				});
				live.resolve();
				await release.promise;
				callbacks.onEvent({
					delta: "late provider text",
					sequence: 2,
					turnId: execution.turnId,
					type: "text-delta",
				});
				callbacks.onTerminal({
					finishedAt: 2,
					sequence: 3,
					turnId: execution.turnId,
					type: "agent-turn-completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return {};
			},
		},
	});

	const send = engine.send(sendInput());
	await live.promise;
	engine.interrupt();
	release.resolve();
	await send;

	const assistant = engine
		.getSnapshot()
		.context.findLast(({ role }) => role === "assistant");
	expect(assistant?.metadata?.interrupted).toBe(true);
	expect(assistant?.parts).toContainEqual({
		text: "before interruption",
		type: "text",
	});
	expect(assistant?.parts).not.toContainEqual({
		text: "late provider text",
		type: "text",
	});
});

test("retries a stored message without appending another user message", async () => {
	const commits: SessionRecord[] = [];
	const stored = message("u1", "retry me");
	const engine = createTestAgentSession([stored], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: answeringRuntime(),
	});

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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});

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

test("deadline expiration aborts a preparing Agent Session send", async () => {
	const externalizeStarted = Promise.withResolvers<void>();
	const files: SessionFilePart[] = [
		{
			filename: "deadline.txt",
			mediaType: "text/plain",
			type: "file",
			url: "data:text/plain;base64,QQ==",
		},
	];
	const engine = new AgentSessionImpl({
		deadlineMs: 0,
		initialTranscript: [],
		ports: createPorts({
			compaction: createCompactionModule(async () => ({ text: "summary" })),
			attachments: {
				externalize: async (messages, signal) => {
					externalizeStarted.resolve();
					const released = Promise.withResolvers<void>();
					const onAbort = (): void => released.resolve();
					if (signal.aborted) {
						onAbort();
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
					await released.promise;
					signal.removeEventListener("abort", onAbort);
					return [...messages];
				},
				hydrate: async ({ messages }) => [...messages],
				release: () => undefined,
				retain: () => undefined,
			},
		}),
		sessionId: sessionId("agent-session-deadline-test"),
	});
	const send = engine.send(sendInput({ files, userText: "deadline" }));
	await externalizeStarted.promise;

	await expect(send).resolves.toEqual({
		rejected: true,
		reason: "Session send deadline exceeded.",
	});
	expect(engine.getSnapshot().turnActive).toBe(false);
	await engine.internalPort.shutdown();
});

test("interrupts the turn, not the Steering Message it delivered", async () => {
	const accepting = Promise.withResolvers<void>();
	const corrected = Promise.withResolvers<void>();
	const parked = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		turnRunner: {
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
	const engine = createTestAgentSession([], undefined, {
		turnRunner: streaming.runtime,
	});

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

test("persists the interrupted Agent Turn terminal checkpoint", async () => {
	const commits: SessionRecord[] = [];
	const streaming = createStreamingRuntime();
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			commits.push(record);
		},
		turnRunner: {
			requestOverheadTokens: () => 0,
			run: async (request) => {
				const result = await streaming.runtime.run(request);
				await request.callbacks.commitTerminal(
					fromPartial<SessionRecord>({
						outcome: {
							kind: "assistant",
							terminal: { kind: "cancelled" },
						},
					})
				);
				return result;
			},
		},
	});

	const send = engine.send(sendInput());
	await streaming.live;
	engine.interrupt();
	streaming.release();
	await expect(send).resolves.toEqual({ rejected: false });

	expect(commits.map(({ outcome }) => outcome.kind)).toEqual([
		"user",
		"assistant",
	]);
	expect(commits[1]?.outcome).toMatchObject({
		kind: "assistant",
		terminal: { kind: "cancelled" },
	});
});
test("reflects a durable prompt when interruption lands during its commit", async () => {
	const commitStarted = Promise.withResolvers<void>();
	const releaseCommit = Promise.withResolvers<void>();
	const engine = createTestAgentSession([], undefined, {
		commitRecord: async ({ record }) => {
			if (record.outcome.kind === "user") {
				commitStarted.resolve();
				await releaseCommit.promise;
			}
		},
	});

	const send = engine.send(sendInput({ userText: "durable prompt" }));
	await commitStarted.promise;
	engine.interrupt();
	releaseCommit.resolve();

	await expect(send).resolves.toMatchObject({ rejected: true });
	expect(userPrompts(engine.getSnapshot().context)).toEqual(["durable prompt"]);
	expect(userPrompts(engine.getSnapshot().transcript)).toEqual([
		"durable prompt",
	]);
});
