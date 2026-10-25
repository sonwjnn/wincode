import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import {
	createProviderCollection,
	type Provider,
	type ProviderModel,
} from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import {
	createSessionCompaction,
	rebuildActiveMessages,
	serializeMessagesForCompaction,
} from "@/modules/sessions/compaction/compaction";
import { estimateCompactionTokens } from "@/modules/sessions/compaction/config";
import type { SessionCompactionError } from "@/modules/sessions/compaction/error";
import { createProviderSummaryGenerator } from "@/modules/sessions/compaction/summary-generator";
import type {
	SessionCompaction,
	SummaryGeneratorInput,
} from "@/modules/sessions/compaction/types";
import {
	type AgentSessionAdaptersOptions,
	createAgentSessionAdapters,
} from "@/modules/sessions/host/agent-session-adapters";
import {
	type SessionMessage,
	sanitizeSessionSkillToolPart,
} from "@/modules/sessions/message";
import {
	type AttachmentMetadataRecord,
	type AttachmentMetadataRepository,
	createSessionAttachmentStore,
	getAttachmentReference,
} from "@/modules/sessions/storage/attachment-store";
import { createHangingSummary } from "../support/hanging-summary";
import {
	agentTurnId,
	compactionId,
	modelId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const model: ProviderModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
test("rejects a skill tool part without a Tool Call Identifier", () => {
	expect(() =>
		sanitizeSessionSkillToolPart({
			input: {},
			output: {},
			state: "output-available",
			toolCallId: "",
			toolName: "skill",
			type: "dynamic-tool",
		})
	).toThrow("invalid Tool Call Identifier");
});

const message = (
	id: string,
	role: SessionMessage["role"],
	text: string
): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text, type: "text" }],
		role,
	});

const makeStore = (initial: SessionCompaction | null = null) => {
	let latest = initial;
	const appendCompaction = mock(async (input) => {
		const entry: SessionCompaction = {
			...input,
			completedAt: input.completedAt ?? new Date("2026-08-30T00:00:00.000Z"),
			createdAt: input.createdAt ?? new Date("2026-08-30T00:00:00.000Z"),
			id: input.id ?? compactionId("entry-generated"),
			sequence: (latest?.sequence ?? 0) + 1,
		};
		latest = entry;
		return entry;
	});
	return {
		appendCompaction,
		getLatestCompaction: mock(async () => latest),
	};
};

const createAttachmentRepository = (): AttachmentMetadataRepository => {
	const records = new Map<string, AttachmentMetadataRecord>();
	return {
		delete: (attachmentId) => {
			records.delete(attachmentId);
		},
		get: (attachmentId) => records.get(attachmentId),
		list: () => [...records.values()],
		put: (record) => {
			records.set(record.attachmentId, record);
		},
	};
};

const settings = {
	enabled: true,
	keepRecentTokens: 1,
	modelContextLimit: 65_536,
	thresholdTokens: null,
} as const;

test("compacts complete turns into a durable summary and recent tail", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async (input: SummaryGeneratorInput) => ({
		text: `summary for ${input.serializedMessages}`,
		usage: { inputTokens: 30, outputTokens: 5 },
	}));
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-1"),
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const messages = [
		message("u1", "user", "first request"),
		message("a1", "assistant", "first answer"),
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
	];

	const result = await compaction.compact({
		session: { messages, sessionId: sessionId("session-1") },
		focus: "preserve the migration decision",
		model,
		settings,
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-1"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(result.entry).toMatchObject({
		firstKeptUiMessageId: sessionMessageId("u2"),
		focus: "preserve the migration decision",
		sequence: 1,
		throughMessageUiId: sessionMessageId("a1"),
		trigger: "manual",
		tokensBefore: 4,
	});
	expect(result.entry.summary.coveredMessageIds).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(summaryGenerator).toHaveBeenCalledWith(
		expect.objectContaining({
			focus: "preserve the migration decision",
			model,
		})
	);
});

test("compaction invalidates retained usage on reopen and reports the current projection on the next compact", async () => {
	let sequence = 0;
	const compaction = createSessionCompaction({
		store: makeStore(),
		generateId: () => compactionId(`epoch-${++sequence}`),
		summaryGenerator: async () => ({ text: "Short handoff." }),
	});
	const messages: SessionMessage[] = [
		message("u1", "user", "x".repeat(20_000)),
		message("a1", "assistant", "y".repeat(20_000)),
		message("u2", "user", "u".repeat(1000)),
		{
			...message("a2", "assistant", "a".repeat(1000)),
			metadata: {
				model,
				usage: { inputTokens: 90_000, outputTokens: 100 },
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: { inputTokens: 90_000, outputTokens: 100 },
				},
			},
		},
	];
	const policy = {
		enabled: true,
		keepRecentTokens: 600,
		modelContextLimit: 65_536,
		thresholdTokens: 80_000,
	};
	const first = await compaction.compact({
		session: { sessionId: sessionId("epoch-session"), messages },
		model,
		settings: policy,
		trigger: "threshold",
	});
	expect(compaction.needsCompaction(first.activeMessages, policy)).toBe(false);
	expect(
		compaction.needsCompaction(
			rebuildActiveMessages(messages, first.entry),
			policy
		)
	).toBe(false);
	const fresh: SessionMessage[] = [
		message("u3", "user", "n".repeat(1000)),
		{
			...message("a3", "assistant", "r".repeat(1000)),
			metadata: {
				model,
				usage: { inputTokens: 40_000, outputTokens: 10 },
				contextMeasurement: {
					epoch: `compaction:${first.entry.id}`,
					stepId: "step-2",
					usage: { inputTokens: 40_000, outputTokens: 10 },
				},
			},
		},
	];
	const transcript = [...messages, ...fresh];
	const second = await compaction.compact({
		session: { sessionId: sessionId("epoch-session"), messages: transcript },
		model,
		settings: policy,
		trigger: "manual",
	});
	expect(second.entry.tokensBefore).toBe(40_010);
	expect(
		compaction.needsCompaction(
			rebuildActiveMessages(transcript, second.entry),
			policy
		)
	).toBe(false);
	expect(messages.at(-1)?.metadata?.usage?.inputTokens).toBe(90_000);
});

test("keeps the turn a Steering Message joined whole", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-1"),
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length,
	});
	const messages: SessionMessage[] = [
		message("u1", "user", "first request"),
		message("a1", "assistant", "first answer"),
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
		{
			...message("u3", "user", "use the cache instead"),
			metadata: { joinedTurnId: agentTurnId("turn-2") },
		},
	];

	const result = await compaction.compact({
		session: { messages, sessionId: sessionId("session-1") },
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 3,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	// The correction belongs to the turn it joined: the turn that opened it
	// stays verbatim, and only the history before it is summarized.
	expect(result.entry.firstKeptUiMessageId).toBe(sessionMessageId("u2"));
	expect(result.entry.summary.coveredMessageIds).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-1"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
		sessionMessageId("u3"),
	]);
});

test("does not summarize history already covered by the recent budget", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "unused summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "only request"),
					message("a1", "assistant", "only answer"),
				],
				sessionId: sessionId("session-short"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 10,
				modelContextLimit: 65_536,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "history-too-short" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});
test("does not summarize when all complete history fits recent budget", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "unused summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "second"),
					message("a2", "assistant", "answer"),
				],
				sessionId: sessionId("session-all-recent"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 10,
				modelContextLimit: 65_536,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "history-too-short" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("keeps retention identical across manual and threshold triggers", async () => {
	const run = async (trigger: "manual" | "threshold") => {
		const store = makeStore();
		const compaction = createSessionCompaction({
			store,
			summaryGenerator: async () => ({ text: "same summary" }),
			estimateTokens: (messages) => messages.length,
		});
		return compaction.compact({
			session: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "current"),
					message("a2", "assistant", "answer"),
				],
				sessionId: sessionId(`session-${trigger}`),
			},
			model,
			settings,
			trigger,
		});
	};

	const manual = await run("manual");
	const threshold = await run("threshold");

	expect(manual.activeMessages.slice(1)).toEqual(
		threshold.activeMessages.slice(1)
	);
	expect(manual.entry.firstKeptUiMessageId).toBe(
		threshold.entry.firstKeptUiMessageId
	);
	expect(manual.entry.throughMessageUiId).toBe(
		threshold.entry.throughMessageUiId
	);
	expect(manual.entry.trigger).toBe("manual");
	expect(threshold.entry.trigger).toBe("threshold");
});

test("rebuilds the active context from the newest durable compaction", () => {
	const latest: SessionCompaction = {
		completedAt: new Date("2026-08-30T00:00:00.000Z"),
		createdAt: new Date("2026-08-30T00:00:00.000Z"),
		firstKeptUiMessageId: sessionMessageId("u2"),
		id: compactionId("entry-1"),
		sequence: 1,
		sessionId: sessionId("session-rebuild"),
		summarizationModel: model,
		summary: {
			coveredMessageIds: [sessionMessageId("u1"), sessionMessageId("a1")],
			formatVersion: 1,
			text: "preserve the migration decision",
		},
		throughMessageUiId: sessionMessageId("a1"),
		estimatedTokensAfter: 20,
		tokensBefore: 100,
		trigger: "manual",
	};
	const messages = [
		message("u1", "user", "first request"),
		message("a1", "assistant", "first answer"),
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
	];

	const active = rebuildActiveMessages(messages, latest);

	expect(active.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-1"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(active[0]?.parts[0]).toMatchObject({
		text: expect.stringContaining("preserve the migration decision"),
		type: "text",
	});
});

test("fails closed when a durable compaction boundary is missing", () => {
	const latest: SessionCompaction = {
		completedAt: new Date("2026-08-30T00:00:00.000Z"),
		createdAt: new Date("2026-08-30T00:00:00.000Z"),
		firstKeptUiMessageId: sessionMessageId("missing-message"),
		id: compactionId("entry-invalid"),
		sequence: 2,
		sessionId: sessionId("session-invalid"),
		summarizationModel: model,
		summary: {
			coveredMessageIds: [sessionMessageId("old-message")],
			formatVersion: 1,
			text: "summary",
		},
		throughMessageUiId: sessionMessageId("old-message"),
		estimatedTokensAfter: 1,
		tokensBefore: 2,
		trigger: "manual",
	};

	expect(() =>
		rebuildActiveMessages([message("u1", "user", "current")], latest)
	).toThrow("entry-invalid");
});

test("Host threshold checks carry forward same-epoch usage measured by the previous conversation model", () => {
	const compaction = createSessionCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: () => 1,
	});
	const previousModel: ProviderModelSelection = {
		modelId: modelId("old-model"),
		providerId: "old-provider",
	};
	const selectedModel: ProviderModelSelection = {
		modelId: modelId("selected-model"),
		providerId: "selected-provider",
	};
	const messages: SessionMessage[] = [
		message("u1", "user", "request"),
		{
			...message("a1", "assistant", "answer"),
			metadata: {
				model: previousModel,
				usage: { inputTokens: 90_000, outputTokens: 100 },
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: { inputTokens: 90_000, outputTokens: 100 },
				},
			},
		},
	];
	const adapters = createAgentSessionAdapters(
		fromPartial<AgentSessionAdaptersOptions>({
			capabilities: {
				getCapabilityCeiling: () => undefined,
				getCompactionModule: () => compaction,
			},
			cacheWarming: {},
			isShutDown: () => false,
			providerCollection: {},
			sessionId: sessionId("host-model-forwarding"),
			statefulAgent: {},
			withSessionWork: async (action: () => Promise<void>) => action(),
		})
	);

	expect(
		adapters.compaction.needsCompaction(
			messages,
			{ enabled: true, thresholdTokens: 80_000 },
			selectedModel
		)
	).toBe(true);
});

test("Host threshold estimates messages added after previous-model usage", () => {
	const compaction = createSessionCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length * 500,
	});
	const previousModel: ProviderModelSelection = {
		modelId: modelId("old-model"),
		providerId: "old-provider",
	};
	const selectedModel: ProviderModelSelection = {
		modelId: modelId("selected-model"),
		providerId: "selected-provider",
	};
	const measuredUsage = { inputTokens: 70_000, outputTokens: 100 };
	const messages: SessionMessage[] = [
		message("u1", "user", "request"),
		{
			...message("a1", "assistant", "answer"),
			metadata: {
				model: previousModel,
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: measuredUsage,
				},
			},
		},
		message("u2", "user", "unmeasured follow-up"),
		{
			...message("a2", "assistant", "answer without a measurement"),
			metadata: { model: selectedModel },
		},
	];

	expect(
		compaction.needsCompaction(
			messages,
			{ enabled: true, thresholdTokens: 70_700 },
			selectedModel
		)
	).toBe(true);
});

test("uses provider-reported usage for threshold decisions", () => {
	const compaction = createSessionCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: () => 1,
	});
	const assistant = message("a1", "assistant", "answer");
	const messages: SessionMessage[] = [
		message("u1", "user", "request"),
		{
			...assistant,
			metadata: {
				model,
				usage: { inputTokens: 90, outputTokens: 20 },
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: { inputTokens: 90, outputTokens: 20 },
				},
			},
		},
	];

	expect(
		compaction.needsCompaction(messages, {
			enabled: true,
			thresholdTokens: 100,
		})
	).toBe(true);
});
test("counts cached input within the provider total for compaction thresholds", () => {
	const compaction = createSessionCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: () => 0,
	});
	const messages: SessionMessage[] = [
		message("u1", "user", "request"),
		{
			...message("a1", "assistant", "answer"),
			metadata: {
				model,
				usage: {
					cacheReadTokens: 60,
					cacheWriteTokens: 10,
					inputTokens: 90,
					outputTokens: 20,
				},
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: {
						inputTokens: 90,
						outputTokens: 20,
						cacheReadTokens: 60,
						cacheWriteTokens: 10,
					},
				},
			},
		},
	];

	expect(
		compaction.needsCompaction(messages, {
			enabled: true,
			thresholdTokens: 100,
		})
	).toBe(true);
	expect(
		compaction.needsCompaction(messages, {
			enabled: true,
			thresholdTokens: 111,
		})
	).toBe(false);
});

test("adds estimated trailing context after the latest provider usage", () => {
	const compaction = createSessionCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length * 15,
	});
	const messages: SessionMessage[] = [
		message("u1", "user", "request"),
		{
			...message("a1", "assistant", "answer"),
			metadata: {
				model,
				usage: { inputTokens: 90, outputTokens: 10 },
				contextMeasurement: {
					epoch: "initial",
					stepId: "step-1",
					usage: { inputTokens: 90, outputTokens: 10 },
				},
			},
		},
		message("u2", "user", "new request"),
		message("a2", "assistant", "new answer"),
	];

	expect(
		compaction.needsCompaction(messages, {
			enabled: true,
			thresholdTokens: 120,
		})
	).toBe(true);
	expect(
		compaction.needsCompaction(messages, {
			enabled: true,
			thresholdTokens: 131,
		})
	).toBe(false);
});
test("fallback estimation follows canonical visible content", () => {
	const textOnly = message("text", "user", "request");
	const shortTool = {
		input: { command: "pwd" },
		output: { output: "ok" },
		state: "output-available",
		toolCallId: toolCallId("call-1"),
		type: "tool-shell",
	} as const;
	const longTool = {
		...shortTool,
		output: { output: "x".repeat(1000) },
	};
	const shortEstimate = estimateCompactionTokens([
		textOnly,
		fromPartial<SessionMessage>({
			id: sessionMessageId("assistant-short"),
			parts: [{ text: "thinking", type: "reasoning" }, shortTool],
			role: "assistant",
		}),
	]);
	const longEstimate = estimateCompactionTokens([
		textOnly,
		fromPartial<SessionMessage>({
			id: sessionMessageId("assistant-long"),
			parts: [{ text: "thinking", type: "reasoning" }, longTool],
			role: "assistant",
		}),
	]);

	expect(shortEstimate).toBeGreaterThan(estimateCompactionTokens([textOnly]));
	expect(longEstimate).toBeGreaterThan(shortEstimate);
	const roleToolEstimate = estimateCompactionTokens([
		textOnly,
		fromAny({
			id: sessionMessageId("tool-result"),
			parts: [
				{
					output: { output: "x".repeat(1000) },
					toolCallId: toolCallId("call-1"),
					type: "tool-result",
				},
			],
			role: "tool",
		}),
	]);
	expect(roleToolEstimate).toBeGreaterThan(shortEstimate);
});
test("summary output leaves room for the retained conversation, overhead, and next response reserve", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async (_input: SummaryGeneratorInput) => ({
		text: "budgeted summary",
		usage: { inputTokens: 1, outputTokens: 1 },
	}));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) =>
			messages.some(({ id }) => id.startsWith("compaction:"))
				? 30
				: messages.length * 10,
	});

	await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "first"),
				message("a1", "assistant", "answer"),
				message("u2", "user", "current"),
				message("a2", "assistant", "answer"),
			],
			sessionId: sessionId("session-budget"),
		},
		model,
		settings: {
			compactionOverheadTokens: 10,
			enabled: true,
			keepRecentTokens: 20,
			modelContextLimit: 2000,
			reserveTokens: 800,
			summaryMaxOutputTokens: 4096,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(summaryGenerator).toHaveBeenCalledTimes(1);
	// 2000 context - 20 retained - 10 request overhead - 800 next-response reserve.
	expect(summaryGenerator.mock.calls[0]?.[0].maxOutputTokens).toBe(1170);
});

test("limits summary size by the rebuilt conversation's real request overhead and reserve", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async (_input: SummaryGeneratorInput) => ({
		text: "budgeted summary",
	}));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) =>
			messages.some(({ id }) => id.startsWith("compaction:"))
				? 30
				: messages.length * 10,
	});

	await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "first"),
				message("a1", "assistant", "answer"),
				message("u2", "user", "current"),
				message("a2", "assistant", "answer"),
			],
			sessionId: sessionId("session-summary-conversation-overhead"),
		},
		model,
		settings: {
			compactionOverheadTokens: 6500,
			enabled: true,
			keepRecentTokens: 20,
			modelContextLimit: 8192,
			reserveTokens: 1024,
			summaryMaxOutputTokens: 4096,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(summaryGenerator.mock.calls[0]?.[0].maxOutputTokens).toBe(648);
});

test("rejects an escaped summary request before generation or persistence", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "summary" }));
	const compaction = createSessionCompaction({ store, summaryGenerator });

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "&".repeat(40_000)),
					message("a1", "assistant", "completed old task"),
					message("u2", "user", "current request"),
					message("a2", "assistant", "current response"),
				],
				sessionId: sessionId("session-oversized-summary-request"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 100,
				modelContextLimit: 8192,
				reserveTokens: 1024,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "context-still-too-large" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("rejects a summary chain beyond four requests without committing a partial handoff", async () => {
	const store = makeStore();
	const summaryInputs: SummaryGeneratorInput[] = [];
	const summaryGenerator = mock(async (input: SummaryGeneratorInput) => {
		summaryInputs.push(input);
		return { text: "bounded intermediate handoff" };
	});
	const compaction = createSessionCompaction({ store, summaryGenerator });
	const messages = Array.from({ length: 32 }, (_, index) => [
		message(
			`summary-limit-user-${index}`,
			"user",
			`user evidence ${index} ${"historical user detail ".repeat(320)}`
		),
		message(
			`summary-limit-assistant-${index}`,
			"assistant",
			`assistant evidence ${index} ${"historical assistant detail ".repeat(320)}`
		),
	]).flat();

	await expect(
		compaction.compact({
			session: {
				messages,
				sessionId: sessionId("session-summary-chain-request-limit"),
			},
			model,
			settings: {
				...settings,
				summaryContextLimit: 4096,
				summaryMaxOutputTokens: 1024,
			},
			trigger: "manual",
		})
	).rejects.toThrow("4-request limit");

	expect(summaryInputs.length).toBeGreaterThan(0);
	expect(summaryInputs.length).toBeLessThanOrEqual(4);
	expect(
		summaryInputs.reduce(
			(total, { maxOutputTokens }) => total + (maxOutputTokens ?? 0),
			0
		)
	).toBeLessThanOrEqual(1024);
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("rejects aggregate estimated summary input above 128,000 tokens without persisting", async () => {
	const store = makeStore();
	const summaryInputs: SummaryGeneratorInput[] = [];
	const summaryGenerator = mock(async (input: SummaryGeneratorInput) => {
		summaryInputs.push(input);
		return { text: "bounded intermediate handoff" };
	});
	const compaction = createSessionCompaction({ store, summaryGenerator });
	const largeTurn = (index: number) => [
		message(
			`summary-input-user-${index}`,
			"user",
			`user ${index} ${"x".repeat(80_000)}`
		),
		message(
			`summary-input-assistant-${index}`,
			"assistant",
			`assistant ${index} ${"y".repeat(80_000)}`
		),
	];

	await expect(
		compaction.compact({
			session: {
				messages: Array.from({ length: 12 }, (_, index) =>
					largeTurn(index + 1)
				).flat(),
				sessionId: sessionId("session-summary-chain-input-limit"),
			},
			model,
			settings: {
				...settings,
				keepRecentTokens: 1,
				modelContextLimit: 1_000_000,
				summaryContextLimit: 1_000_000,
				summaryMaxOutputTokens: 512,
			},
			trigger: "manual",
		})
	).rejects.toThrow("128000-token estimated input budget");

	expect(summaryInputs.length).toBeGreaterThan(0);
	expect(summaryInputs).toHaveLength(1);
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("does not generate or persist when the summary budget is not viable", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) =>
			messages.some(({ id }) => id.startsWith("compaction:"))
				? 20
				: messages.length * 10,
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "current"),
					message("a2", "assistant", "answer"),
				],
				sessionId: sessionId("session-budget-too-small"),
			},
			model,
			settings: {
				compactionOverheadTokens: 10,
				enabled: true,
				keepRecentTokens: 20,
				modelContextLimit: 50,
				reserveTokens: 40,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "context-still-too-large" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("uses the global default context window when compaction settings omit one", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length * 10,
	});

	await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "first"),
				message("a1", "assistant", "answer"),
				message("u2", "user", "current"),
				message("a2", "assistant", "answer"),
			],
			sessionId: sessionId("session-unknown-context-budget"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 20,
			reserveTokens: 1024,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	expect(summaryGenerator).toHaveBeenCalledTimes(1);
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

test("repeated compaction passes the prior summary and only the new compacted span", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "new summary" }));
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-2"),
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const initialMessages = [
		message("u1", "user", "one"),
		message("a1", "assistant", "one answer"),
		message("u2", "user", "two"),
		message("a2", "assistant", "two answer"),
	];
	await compaction.compact({
		session: { messages: initialMessages, sessionId: sessionId("session-2") },
		model,
		settings,
		trigger: "manual",
	});
	const nextMessages = [
		...initialMessages,
		message("u3", "user", "three"),
		message("a3", "assistant", "three answer"),
	];
	await compaction.compact({
		session: { messages: nextMessages, sessionId: sessionId("session-2") },
		model,
		settings,
		trigger: "threshold",
	});

	expect(summaryGenerator).toHaveBeenLastCalledWith(
		expect.objectContaining({
			previousSummary: expect.objectContaining({ text: "new summary" }),
			serializedMessages: expect.stringContaining("message id=u2"),
			model,
		})
	);
});

test("rejects an injected summary that exceeds the planned output budget", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "x".repeat(1200) }));
	const compaction = createSessionCompaction({ store, summaryGenerator });

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "a".repeat(20_000)),
					message("a1", "assistant", "old answer"),
					message("u2", "user", "current request"),
					message("a2", "assistant", "current answer"),
				],
				sessionId: sessionId("session-summary-output-overrun"),
			},
			model,
			settings: {
				summaryMaxOutputTokens: 256,
				enabled: true,
				keepRecentTokens: 100,
				modelContextLimit: 8192,
				reserveTokens: 256,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "summary-failed" });
	expect(summaryGenerator).toHaveBeenCalledWith(
		expect.objectContaining({ maxOutputTokens: 256 })
	);
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("a repeated compaction must reduce the current context, not the source transcript", async () => {
	const store = makeStore();
	let summaries = 0;
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({
			text: ++summaries === 1 ? "Short handoff." : "z".repeat(3000),
		}),
	});
	const initialMessages = [
		message("u1", "user", "x".repeat(20_000)),
		message("a1", "assistant", "y".repeat(20_000)),
		message("u2", "user", "u".repeat(1000)),
		message("a2", "assistant", "a".repeat(1000)),
	];
	const policy = {
		enabled: true,
		keepRecentTokens: 600,
		modelContextLimit: 65_536,
		reserveTokens: 2048,
		thresholdTokens: null,
	};
	const first = await compaction.compact({
		session: {
			sessionId: sessionId("session-reduction-projection"),
			messages: initialMessages,
		},
		model,
		settings: policy,
		trigger: "manual",
	});
	const transcript = [
		...initialMessages,
		message("u3", "user", "n".repeat(1000)),
		message("a3", "assistant", "r".repeat(1000)),
	];

	await expect(
		compaction.compact({
			session: {
				sessionId: sessionId("session-reduction-projection"),
				messages: transcript,
			},
			model,
			settings: policy,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "not-needed" });

	expect(first.entry.estimatedTokensAfter).toBeLessThan(
		first.entry.tokensBefore
	);
	expect(summaries).toBe(2);
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

test("rejects compaction when its projected context is larger", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => {
			if (messages.some(({ id }) => id.startsWith("compaction:"))) {
				return 9000;
			}
			return messages.at(-1)?.parts.length === 1 ? 1 : 6200;
		},
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "question"),
					{
						...message("a1", "assistant", "answer"),
						parts: [
							{ text: "first", type: "text" },
							{ text: "second", type: "text" },
						],
					},
				],
				sessionId: sessionId("session-expanding"),
			},
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "not-needed" });
	expect(store.appendCompaction).not.toHaveBeenCalled();
});
test("uses the fallback estimate for strict reduction acceptance", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) =>
			messages.some(({ id }) => id.startsWith("compaction:")) ? 6 : 5,
	});
	const messages: SessionMessage[] = [
		message("u1", "user", "old request"),
		{
			...message("a1", "assistant", "old answer"),
			metadata: {
				model,
				usage: { inputTokens: 100, outputTokens: 0 },
			},
		},
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
	];

	await expect(
		compaction.compact({
			session: { messages, sessionId: sessionId("session-local-acceptance") },
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 1,
				modelContextLimit: 65_536,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "not-needed" });
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("summary failure and cancellation do not append durable state", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async ({ signal }: SummaryGeneratorInput) => {
		if (signal?.aborted) {
			throw new Error("aborted");
		}
		throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
	});
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const session = {
		messages: [
			message("u1", "user", "first"),
			message("a1", "assistant", "answer"),
			message("u2", "user", "second"),
			message("a2", "assistant", "answer"),
		],
		sessionId: sessionId("session-3"),
	};

	await expect(
		compaction.compact({
			session,
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({
		code: "summary-failed",
		message:
			"Compaction summary generation failed: Model authentication failed.",
	});
	expect(store.appendCompaction).not.toHaveBeenCalled();

	const controller = new AbortController();
	controller.abort();
	await expect(
		compaction.compact({
			session,
			model,
			settings,
			trigger: "manual",
			signal: controller.signal,
		})
	).rejects.toMatchObject({ code: "cancelled" });
});

test("an output-limited Provider summary never becomes durable handoff context", async () => {
	const store = makeStore();
	const providerModel: ProviderModel = {
		limits: { contextWindowTokens: 8192, maxOutputTokens: 512 },
		modelId: "fixture-summary",
		protocolId: "fixture",
		providerId: "fixture",
	};
	const provider: Provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => ({ authorization: "fixture-only" }),
		async *streamChat() {
			yield { delta: "partial handoff", type: "text-delta" };
			yield {
				completion: { kind: "incomplete", reason: "output-limit" },
				type: "finish",
			};
		},
	};
	const collection = createProviderCollection();
	collection.register(provider);
	await collection.setCredential("fixture", { token: "fixture-only" });
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: createProviderSummaryGenerator(collection),
		estimateTokens: (messages) => messages.length,
	});

	try {
		await expect(
			compaction.compact({
				session: {
					messages: [
						message("u1", "user", "first"),
						message("a1", "assistant", "answer"),
						message("u2", "user", "second"),
						message("a2", "assistant", "answer"),
					],
					sessionId: sessionId("session-incomplete-summary"),
				},
				model: {
					modelId: modelId(providerModel.modelId),
					providerId: providerModel.providerId,
				},
				settings,
				trigger: "manual",
			})
		).rejects.toMatchObject({ code: "summary-failed" });
		expect(store.appendCompaction).not.toHaveBeenCalled();
	} finally {
		await collection.close();
	}
});

test("persistence failure does not commit a compaction entry", async () => {
	const store = makeStore();
	store.appendCompaction.mockImplementation(async () => {
		throw new Error("disk full");
	});
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "second"),
					message("a2", "assistant", "answer"),
				],
				sessionId: sessionId("session-persistence"),
			},
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "persistence-failed" });
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

/** The shared hanging generator, mocked so a test can assert its call count. */
const hangingCompaction = () => {
	const hanging = createHangingSummary();
	return {
		release: hanging.release,
		summaryGenerator: mock(hanging.summaryGenerator),
	};
};

const compactionSession = () => ({
	messages: [
		message("u1", "user", "first"),
		message("a1", "assistant", "answer"),
		message("u2", "user", "second"),
		message("a2", "assistant", "answer"),
	],
	sessionId: sessionId("session-4"),
});

test("only one compaction operation runs per session", async () => {
	const { release, summaryGenerator } = hangingCompaction();
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-4"),
		store: makeStore(),
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const session = compactionSession();
	const first = compaction.compact({
		session,
		model,
		settings,
		trigger: "threshold",
	});
	const second = compaction.compact({
		session,
		model,
		settings,
		trigger: "threshold",
	});

	expect(second).toBe(first);
	release();
	await first;
	expect(summaryGenerator).toHaveBeenCalledTimes(1);
});

test("joins an in-flight maintenance compaction across a selection change", async () => {
	const { release, summaryGenerator } = hangingCompaction();
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-6"),
		store: makeStore(),
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const session = compactionSession();
	const first = compaction.compact({
		session,
		model,
		settings,
		trigger: "threshold",
	});
	// The selection only decides how the summary is generated: two threshold
	// requests share an intent, so neither is refused and the prompt is not lost.
	const second = compaction.compact({
		session,
		model: { modelId: modelId("gpt-5.6-vega"), providerId: "anthropic" },
		settings,
		trigger: "threshold",
	});

	expect(second).toBe(first);
	release();
	await first;
	expect(summaryGenerator).toHaveBeenCalledTimes(1);
});

test("refuses another intent instead of answering with the in-flight entry", async () => {
	const { release, summaryGenerator } = hangingCompaction();
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-5"),
		store: makeStore(),
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const session = compactionSession();
	const automatic = compaction.compact({
		session,
		model,
		settings,
		trigger: "threshold",
	});
	// The manual caller must never receive the automatic entry: its focus would
	// be dropped and it would be told the wrong intent ran.
	const manual = compaction.compact({
		focus: "preserve database decisions",
		session,
		model,
		settings,
		trigger: "manual",
	});
	const outcome = manual.then(
		(result) => result.entry.trigger,
		(error: unknown) => (error as SessionCompactionError).code
	);

	release();
	const result = await automatic;
	expect(result.entry.trigger).toBe("threshold");
	await expect(outcome).resolves.toBe("in-flight");
	expect(summaryGenerator).toHaveBeenCalledTimes(1);
});

test("omits reasoning while preserving terminal tool outcomes beside bounded payloads", () => {
	const serialized = serializeMessagesForCompaction([
		fromPartial<SessionMessage>({
			id: sessionMessageId("u-tool-outcome"),
			parts: [
				{ text: "PRIVATE_REASONING_MARKER", type: "reasoning" },
				{
					errorText: "CRITICAL_OUTCOME_MARKER",
					input: { command: "x".repeat(16_000) },
					state: "output-error",
					toolCallId: toolCallId("call-outcome"),
					type: "tool-shell",
				},
			],
			role: "assistant",
		}),
		fromAny<SessionMessage, object>({
			id: sessionMessageId("tool-result-message"),
			parts: [
				{
					output: { output: `${"x".repeat(16_000)}CRITICAL_TOOL_RESULT_TAIL` },
					toolCallId: toolCallId("call-result"),
					toolName: "shell",
					type: "tool-result",
				},
			],
			role: "tool",
		}),
	]);

	expect(serialized).not.toContain("PRIVATE_REASONING_MARKER");
	expect(serialized).toContain("call-outcome");
	expect(serialized).toContain("output-error");
	expect(serialized).toContain("CRITICAL_OUTCOME_MARKER");
	expect(serialized).toContain("call-result");
	expect(serialized).toContain('"toolName":"shell"');
	expect(serialized).toContain("CRITICAL_TOOL_RESULT_TAIL");
});

test("keeps tool payload previews within their UTF-8 byte caps", () => {
	const serialized = serializeMessagesForCompaction([
		fromPartial<SessionMessage>({
			id: sessionMessageId("tool-call-byte-caps"),
			parts: [
				{
					errorText: "é".repeat(20_000),
					input: { value: "ié".repeat(10_000) },
					output: "🙂".repeat(5000),
					state: "output-error",
					toolCallId: toolCallId("call-byte-caps"),
					type: "tool-shell",
				},
			],
			role: "assistant",
		}),
		fromAny<SessionMessage, object>({
			id: sessionMessageId("tool-result-byte-caps"),
			parts: [
				{
					errorText: "r🙂".repeat(10_000),
					output: "ø".repeat(20_000),
					toolCallId: toolCallId("result-byte-caps"),
					type: "tool-result",
				},
			],
			role: "tool",
		}),
	]);
	const serializedToolParts = serialized
		.split("\n")
		.filter((line) => line.startsWith('{"type":"tool-'))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const [toolCall, toolResult] = serializedToolParts;

	expect(toolCall).toBeDefined();
	expect(toolResult).toBeDefined();
	if (!(toolCall && toolResult)) {
		throw new Error("The serialized tool call or result is missing.");
	}
	expect(typeof toolCall.inputPreview).toBe("string");
	if (typeof toolCall.inputPreview === "string") {
		expect(
			Buffer.byteLength(toolCall.inputPreview, "utf8")
		).toBeLessThanOrEqual(2000);
	}
	for (const preview of [toolCall.outputPreview, toolResult.outputPreview]) {
		expect(typeof preview).toBe("string");
		if (typeof preview === "string") {
			expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(4000);
		}
	}
	for (const errorText of [toolCall.errorText, toolResult.errorText]) {
		expect(typeof errorText).toBe("string");
		if (typeof errorText === "string") {
			expect(Buffer.byteLength(errorText, "utf8")).toBeLessThanOrEqual(2000);
		}
	}
});

test("serializes old attachments as bounded metadata", () => {
	const serialized = serializeMessagesForCompaction([
		fromPartial<SessionMessage>({
			id: sessionMessageId("u1"),
			parts: [
				{
					filename: "design.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${"a".repeat(500)}`,
				},
			],
			role: "user",
		}),
	]);

	expect(serialized).toContain("design.png");
	expect(serialized).toContain("payloadBytes");
	expect(serialized).toContain("payloadOmitted");
	expect(serialized).not.toContain("data:image/png;base64");
	expect(serialized.length).toBeLessThan(500);
});

test("serializes current-window attachments without hydrating payloads and persists metadata", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-compaction-attachments-")
	);
	const attachmentStore = createSessionAttachmentStore({
		repository: createAttachmentRepository(),
		root,
	});
	const hydrateMessages = mock(attachmentStore.hydrateMessages);
	attachmentStore.hydrateMessages = hydrateMessages;
	const reference = await attachmentStore.ingest({
		bytes: new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
		]),
		filename: "design.png",
		mediaType: "image/png",
	});
	const imageMessage = fromPartial<SessionMessage>({
		...message("u1", "user", "review [Image 1]"),
		parts: [
			{ text: "review [Image 1]", type: "text" },
			attachmentReferenceToFilePart(reference),
		],
	});
	let serializedSummary = "";
	const compaction = createSessionCompaction({
		attachmentStore,
		store: makeStore(),
		summaryGenerator: async (input) => {
			serializedSummary = input.serializedMessages;
			return { text: "image summary data:image/png;base64,aG Vs\nbG8=." };
		},
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});

	const result = await compaction.compact({
		session: {
			messages: [
				imageMessage,
				message("a1", "assistant", "noted"),
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: sessionId("session-attachments"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			maxMediaAttachments: 1,
			maxMediaBytes: 10_000,
			maxMediaTokens: 10_000,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	expect(serializedSummary).toContain("design.png");
	expect(serializedSummary).toContain("payloadOmitted");
	expect(serializedSummary).not.toContain("data:image/png;base64");
	expect(hydrateMessages).not.toHaveBeenCalled();
	expect(result.entry.summary.attachments).toMatchObject([
		{
			attachmentId: reference.attachmentId,
			available: true,
			byteLength: reference.byteLength,
			payloadOmitted: true,
		},
	]);
	expect(JSON.stringify(result.entry)).not.toContain("data:image/png;base64");
});

test("sanitizes completed Skill bodies before summarization", async () => {
	const store = makeStore();
	let serialized = "";
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async (input) => {
			serialized = input.serializedMessages;
			return { text: "summary" };
		},
		estimateTokens: (messages) => messages.length,
	});
	const skillMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("assistant-1"),
		parts: [
			{
				input: { name: "review" },
				output: {
					baseDirectory: "/private/project",
					body: "Never disclose this Skill body.",
					contentHash: "hash",
					name: "review",
					resourcePaths: ["/private/project/resource"],
					source: "explicit",
					status: "loaded",
				},
				state: "output-available",
				toolCallId: toolCallId("skill-1"),
				toolName: "skill",
				type: "dynamic-tool",
			},
		],
		role: "assistant",
	});

	await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "load review"),
				skillMessage,
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: sessionId("session-skill"),
		},
		model,
		settings,
		trigger: "manual",
	});

	expect(serialized).toContain("review");
	expect(serialized).not.toContain("Never disclose this Skill body.");
	expect(serialized).not.toContain("/private/project");
});

test("rejects a compaction that still exceeds the safe context limit", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "second"),
					message("a2", "assistant", "answer"),
				],
				sessionId: sessionId("session-too-large"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 2,
				modelContextLimit: 65_536,
				thresholdTokens: 2,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "context-still-too-large" });
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("splits an oversized single turn only at complete part boundaries", async () => {
	const store = makeStore();
	let serialized = "";
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-split"),
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized = input.serializedMessages;
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "recent suffix", type: "text" },
		],
		role: "assistant",
	});

	const result = await compaction.compact({
		session: {
			messages: [message("u1", "user", "single request"), assistant],
			sessionId: sessionId("session-split"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-split"),
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(result.activeMessages.at(-1)?.parts).toEqual([
		{ text: "recent suffix", type: "text" },
	]);
	expect(result.entry.firstKeptAssistantPartIndex).toBe(2);
	const rebuilt = rebuildActiveMessages(
		[message("u1", "user", "single request"), assistant],
		result.entry
	);
	expect(rebuilt.at(-1)?.parts).toEqual([
		{ text: "recent suffix", type: "text" },
	]);
	expect(serialized).toContain("prefix one");
	expect(serialized).not.toContain("recent suffix");
});
test("does not recompact an unchanged split transcript", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "split summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "prefix", type: "text" },
			{ text: "middle", type: "text" },
			{ text: "suffix", type: "text" },
		],
		role: "assistant",
	});
	const session = {
		messages: [message("u1", "user", "request"), assistant],
		sessionId: sessionId("session-split-unchanged"),
	};
	const compactionInput = {
		session,
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual" as const,
	};

	await compaction.compact(compactionInput);
	await expect(compaction.compact(compactionInput)).rejects.toMatchObject({
		code: "history-too-short",
	});

	expect(summaryGenerator).toHaveBeenCalledTimes(1);
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

test("splits the latest oversized turn without retaining older context", async () => {
	const store = makeStore();
	let serialized = "";
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-latest-split"),
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized = input.serializedMessages;
			return { text: "latest split summary" };
		}),
		estimateTokens: (messages) =>
			messages.some(({ id }) => id.startsWith("compaction:"))
				? 2
				: messages.length,
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a2"),
		parts: [
			{ text: "prefix", type: "text" },
			{ text: "suffix", type: "text" },
		],
		role: "assistant",
	});

	const result = await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "old request"),
				message("a1", "assistant", "old answer"),
				message("u2", "user", "current request"),
				assistant,
			],
			sessionId: sessionId("session-latest-split"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("compaction:entry-latest-split"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(result.activeMessages.at(-1)?.parts).toEqual([
		{ text: "suffix", type: "text" },
	]);
	expect(result.entry.summary.coveredMessageIds).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(serialized).toContain("old request");
});

test("resumes the next summary span after a split-turn boundary", async () => {
	const store = makeStore();
	const serialized: string[] = [];
	const compaction = createSessionCompaction({
		generateId: () => compactionId("entry-split"),
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized.push(input.serializedMessages);
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "recent suffix", type: "text" },
		],
		role: "assistant",
	});

	const first = await compaction.compact({
		session: {
			messages: [message("u1", "user", "single request"), assistant],
			sessionId: sessionId("session-split-resume"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	expect(first.entry.firstKeptAssistantPartIndex).toBe(2);

	const second = await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "single request"),
				assistant,
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: sessionId("session-split-resume"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	expect(second.entry.firstKeptUiMessageId).toBe(sessionMessageId("u2"));
	expect(serialized.at(-1)).toContain("recent suffix");
	expect(serialized.at(-1)).not.toContain("single request");
});

test("does not re-summarize a previously split assistant prefix", async () => {
	const store = makeStore();
	const serialized: string[] = [];
	const compaction = createSessionCompaction({
		generateId: () => compactionId(`entry-${serialized.length + 1}`),
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized.push(input.serializedMessages);
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const firstAssistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "first prefix", type: "text" },
			{ text: "first middle", type: "text" },
			{ text: "first suffix", type: "text" },
		],
		role: "assistant",
	});
	const secondAssistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a2"),
		parts: [
			{ text: "second prefix", type: "text" },
			{ text: "second middle", type: "text" },
			{ text: "second suffix", type: "text" },
		],
		role: "assistant",
	});

	await compaction.compact({
		session: {
			messages: [message("u1", "user", "first request"), firstAssistant],
			sessionId: sessionId("session-split-twice"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	const second = await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "first request"),
				firstAssistant,
				message("u2", "user", "second request"),
				secondAssistant,
			],
			sessionId: sessionId("session-split-twice"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(second.entry.summary.coveredMessageIds).toEqual([
		sessionMessageId("a1"),
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(serialized[1]).toContain("first suffix");
	expect(serialized[1]).not.toContain("first prefix");
	expect(serialized[1]).toContain("second prefix");
});

test("keeps a split tool call paired with its result", async () => {
	const store = makeStore();
	const toolCall = fromPartial<SessionMessage["parts"][number]>({
		input: { command: "pwd" },
		state: "output-available",
		toolCallId: toolCallId("call-split"),
		type: "tool-shell",
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "prefix", type: "text" },
			toolCall,
			{ text: "suffix", type: "text" },
		],
		role: "assistant",
	});
	const toolResult: SessionMessage = fromAny({
		id: sessionMessageId("tool-call-split"),
		parts: [
			{
				output: { output: "ok" },
				toolCallId: toolCallId("call-split"),
				type: "tool-result",
			},
		],
		role: "tool",
	});
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "split tool summary" }),
		estimateTokens: (messages) =>
			messages.reduce(
				(total, current) =>
					total +
					(current.id.startsWith("compaction:") ? 0 : current.parts.length),
				0
			),
	});

	const result = await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "run the command"),
				assistant,
				toolResult,
			],
			sessionId: sessionId("session-tool-pair"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 4,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},

		trigger: "manual",
	});

	expect(result.activeMessages.at(-2)?.parts).toEqual([
		toolCall,
		{ text: "suffix", type: "text" },
	]);
	expect(result.activeMessages.at(-1)).toEqual(toolResult);
	expect(result.entry.firstKeptAssistantPartIndex).toBe(1);
});

test("does not split a paired tool result beyond the recent budget", async () => {
	const store = makeStore();
	const toolCall = fromPartial<SessionMessage["parts"][number]>({
		input: { command: "pwd" },
		state: "output-available",
		toolCallId: toolCallId("call-budget"),
		type: "tool-shell",
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [{ text: "prefix", type: "text" }, toolCall],
		role: "assistant",
	});
	const toolResult: SessionMessage = fromAny({
		id: "tool-call-budget",
		parts: [
			{
				output: { output: "ok" },
				toolCallId: toolCallId("call-budget"),
				type: "tool-result",
			},
		],
		role: "tool",
	});
	const summaryGenerator = mock(async () => ({ text: "unused summary" }));
	const compaction = createSessionCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "run the command"),
					assistant,
					toolResult,
				],
				sessionId: sessionId("session-tool-budget"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 2,
				modelContextLimit: 65_536,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "history-too-short" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("projects the newest attachment against the media budget for estimatedTokensAfter", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-compaction-projection-")
	);
	const attachmentStore = createSessionAttachmentStore({
		repository: createAttachmentRepository(),
		root,
	});
	const oldReference = await attachmentStore.ingest({
		bytes: new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
		]),
		filename: "old.png",
		mediaType: "image/png",
	});
	const largeBytes = new Uint8Array(5010);
	largeBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
	const newReference = await attachmentStore.ingest({
		bytes: largeBytes,
		filename: "new.png",
		mediaType: "image/png",
	});
	const store = makeStore();
	const compaction = createSessionCompaction({
		attachmentStore,
		generateId: () => compactionId("entry-projection"),
		store,
		summaryGenerator: mock(async () => ({ text: "projected summary" })),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => {
				const partTokens = current.parts.reduce((sum, part) => {
					const reference = getAttachmentReference(part);
					return (
						sum + (reference ? Math.ceil(reference.byteLength / 1000) + 1 : 1)
					);
				}, 0);
				return total + partTokens;
			}, 0),
	});
	const user = fromPartial<SessionMessage>({
		id: sessionMessageId("u1"),
		parts: [
			attachmentReferenceToFilePart(oldReference),
			attachmentReferenceToFilePart(newReference),
		],
		role: "user",
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("a1"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "recent suffix", type: "text" },
		],
		role: "assistant",
	});

	const result = await compaction.compact({
		session: {
			messages: [user, assistant],
			sessionId: sessionId("session-projection"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 10,
			maxMediaAttachments: 1,
			maxMediaBytes: 10_000,
			maxMediaTokens: 10_000,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	// Newest (large) attachment is retained: summary(1) + marker(1) +
	// ceil(5010/1000)+1(7) + suffix(1) = 10. Charging oldest-first would omit
	// the large attachment and report 5 instead.
	expect(result.entry.estimatedTokensAfter).toBe(10);
});

const toolMessage = (
	id: string,
	toolName: "edit" | "read" | "write",
	output: unknown
): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [
			{
				output,
				state: "output-available",
				toolCallId: toolCallId(`call-${id}`),
				type: `tool-${toolName}`,
			},
		],
		role: "assistant",
	});

const fileVersionFixture = (seed: string): string =>
	seed.repeat(32).slice(0, 32);

test("summarizes deterministic read and modified files from completed Tool Calls", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "file summary" }),
		estimateTokens: (messages) => messages.length,
	});

	const result = await compaction.compact({
		session: {
			messages: [
				message("u1", "user", "read and edit"),
				toolMessage("read-a", "read", {
					content: "1 | a",
					fileVersion: fileVersionFixture("a"),
					path: "src/a.ts",
				}),
				toolMessage("read-dir", "read", {
					content: "src/",
					path: "src",
				}),
				toolMessage("edit-b", "edit", {
					files: [
						{
							hunkCount: 1,
							newFileVersion: fileVersionFixture("b"),
							oldFileVersion: fileVersionFixture("c"),
							path: "src/b.ts",
							status: "committed",
						},
					],
				}),
				// The common one-file Edit shape reports no files list.
				toolMessage("edit-single", "edit", {
					newFileVersion: fileVersionFixture("d"),
					oldFileVersion: fileVersionFixture("e"),
					path: "src/c.ts",
					replacements: 1,
				}),
				message("u2", "user", "current"),
				message("a2", "assistant", "current answer"),
			],
			sessionId: sessionId("session-file-operations"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 1,
			modelContextLimit: 65_536,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	// The directory read is not a file observation, and the deterministic
	// handoff outlives the model's own prose.
	expect(result.entry.summary.fileOperations).toEqual({
		modified: ["src/b.ts", "src/c.ts"],
		read: ["src/a.ts"],
	});
	expect(result.entry.summary.text).toEndWith(
		"## Files\nRead: src/a.ts\nModified: src/b.ts, src/c.ts"
	);
});

test("a repeated compaction carries the prior cumulative file sets forward", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async () => ({ text: "carried summary" }),
		estimateTokens: (messages) => messages.length,
	});
	const initialMessages = [
		message("u1", "user", "first"),
		toolMessage("read-a", "read", {
			content: "1 | a",
			fileVersion: fileVersionFixture("a"),
			path: "src/a.ts",
		}),
		message("u2", "user", "second"),
		message("a2", "assistant", "second answer"),
	];
	await compaction.compact({
		session: {
			messages: initialMessages,
			sessionId: sessionId("session-carry"),
		},
		model,
		settings,
		trigger: "manual",
	});

	const result = await compaction.compact({
		session: {
			messages: [
				...initialMessages,
				toolMessage("write-c", "write", {
					bytesWritten: 3,
					newFileVersion: fileVersionFixture("c"),
					path: "src/c.ts",
				}),
				message("u3", "user", "third"),
				message("a3", "assistant", "third answer"),
			],
			sessionId: sessionId("session-carry"),
		},
		model,
		settings,
		trigger: "threshold",
	});

	// The earlier Read is outside the new summary span but still tracked.
	expect(result.entry.summary.fileOperations).toEqual({
		modified: ["src/c.ts"],
		read: ["src/a.ts"],
	});
});

const lifecycleMessages = [
	message("u1", "user", "first request"),
	message("a1", "assistant", "first answer"),
	message("u2", "user", "current request"),
	message("a2", "assistant", "current answer"),
];

test("a Plugin cancellation refuses compaction before any summary call", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "generated" }));
	const failed = mock(async () => undefined);
	const compaction = createSessionCompaction({
		lifecycle: {
			before: async () => ({ cancel: "Compaction is paused." }),
			failed,
		},
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: lifecycleMessages,
				sessionId: sessionId("session-plugin-cancel"),
			},
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({
		code: "cancelled",
		message: "Compaction is paused.",
	});
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
	// A deliberate refusal is not a compaction failure.
	expect(failed).not.toHaveBeenCalled();
});

test("a Plugin custom summary still passes host validation and persistence", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "generated" }));
	const completed: SessionCompaction[] = [];
	const compaction = createSessionCompaction({
		lifecycle: {
			before: async () => ({ summary: "Plugin handoff text." }),
			completed: async (entry) => {
				completed.push(entry);
			},
		},
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	const result = await compaction.compact({
		session: {
			messages: lifecycleMessages,
			sessionId: sessionId("session-plugin-summary"),
		},
		model,
		settings,
		trigger: "manual",
	});

	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(result.entry.summary.text).toContain("Plugin handoff text.");
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
	expect(completed).toEqual([result.entry]);
});

test("an oversized Plugin summary fails before persistence and reports the failure once", async () => {
	const store = makeStore();
	const failures: unknown[] = [];
	const compaction = createSessionCompaction({
		lifecycle: {
			before: async () => ({ summary: "x".repeat(1200) }),
			failed: async ({ error }) => {
				failures.push(error);
			},
		},
		store,
		summaryGenerator: async () => ({ text: "generated" }),
	});

	await expect(
		compaction.compact({
			session: {
				messages: [
					message("u1", "user", "a".repeat(20_000)),
					message("a1", "assistant", "old answer"),
					message("u2", "user", "current request"),
					message("a2", "assistant", "current answer"),
				],
				sessionId: sessionId("session-plugin-summary-overrun"),
			},
			model,
			settings: {
				enabled: true,
				keepRecentTokens: 100,
				modelContextLimit: 8192,
				reserveTokens: 256,
				thresholdTokens: null,
			},
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "summary-failed" });
	expect(store.appendCompaction).not.toHaveBeenCalled();
	expect(failures).toHaveLength(1);
});

test("a failing persistence notifies the compaction failure hook once", async () => {
	const store = {
		appendCompaction: mock(async () => {
			throw new Error("store unavailable");
		}),
		getLatestCompaction: mock(async () => null),
	};
	const failures: unknown[] = [];
	const compaction = createSessionCompaction({
		lifecycle: {
			failed: async ({ error }) => {
				failures.push(error);
			},
		},
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			session: {
				messages: lifecycleMessages,
				sessionId: sessionId("session-plugin-persistence"),
			},
			model,
			settings,
			trigger: "threshold",
		})
	).rejects.toMatchObject({ code: "persistence-failed" });
	expect(failures).toHaveLength(1);
});

test("a throwing completed observer cannot undo a committed compaction", async () => {
	const store = makeStore();
	const compaction = createSessionCompaction({
		lifecycle: {
			completed: async () => {
				throw new Error("observer exploded");
			},
		},
		store,
		summaryGenerator: async () => ({ text: "committed summary" }),
		estimateTokens: (messages) => messages.length,
	});

	const result = await compaction.compact({
		session: {
			messages: lifecycleMessages,
			sessionId: sessionId("session-plugin-observer"),
		},
		model,
		settings,
		trigger: "manual",
	});

	expect(result.entry.summary.text).toContain("committed summary");
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

test("a Plugin summary avoids invoking a summary generator", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "generated" }));
	const completed: SessionCompaction[] = [];
	const compaction = createSessionCompaction({
		lifecycle: {
			before: async () => ({ summary: "Plugin handoff without a model." }),
			completed: async (entry) => {
				completed.push(entry);
			},
		},
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	const result = await compaction.compact({
		session: {
			messages: lifecycleMessages,
			sessionId: sessionId("session-deferred-target"),
		},
		model,
		settings,
		trigger: "manual",
	});

	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(result.entry.summary.text).toContain(
		"Plugin handoff without a model."
	);
	expect(completed).toEqual([result.entry]);
});

test("a Plugin summary needs no conversation context-window limit", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "generated" }));
	const compaction = createSessionCompaction({
		lifecycle: {
			before: async () => ({
				summary: "Plugin handoff with an unknown window.",
			}),
		},
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});

	const result = await compaction.compact({
		session: {
			messages: lifecycleMessages,
			sessionId: sessionId("session-unknown-window"),
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 1,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	// The generation budget would have required a known conversation window.
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(result.entry.summary.text).toContain("unknown window");
});
