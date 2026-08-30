import { expect, mock, test } from "bun:test";
import type { ChatModelSelection, CodingAgentUIMessage } from "@wincode/ai";
import {
	createConversationCompaction,
	rebuildActiveMessages,
	serializeMessagesForCompaction,
} from "./compaction";
import type { ConversationCompaction, SummaryGeneratorInput } from "./types";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const message = (
	id: string,
	role: CodingAgentUIMessage["role"],
	text: string
): CodingAgentUIMessage =>
	({
		id,
		parts: [{ text, type: "text" }],
		role,
	}) as CodingAgentUIMessage;

const makeStore = (initial: ConversationCompaction | null = null) => {
	let latest = initial;
	const appendCompaction = mock(async (input) => {
		const entry: ConversationCompaction = {
			...input,
			completedAt: input.completedAt ?? new Date("2026-08-30T00:00:00.000Z"),
			createdAt: input.createdAt ?? new Date("2026-08-30T00:00:00.000Z"),
			id: input.id ?? "entry-generated",
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

const settings = {
	enabled: true,
	keepRecentTokens: 1,
	thresholdTokens: null,
} as const;

test("compacts complete turns into a durable summary and recent tail", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async (input: SummaryGeneratorInput) => ({
		text: `summary for ${input.serializedMessages}`,
		usage: { inputTokens: 30, outputTokens: 5 },
	}));
	const compaction = createConversationCompaction({
		generateId: () => "entry-1",
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
		conversation: { messages, sessionId: "session-1" },
		focus: "preserve the migration decision",
		model,
		settings,
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		"compaction:entry-1",
		"u2",
		"a2",
	]);
	expect(result.entry).toMatchObject({
		firstKeptUiMessageId: "u2",
		focus: "preserve the migration decision",
		sequence: 1,
		throughMessageUiId: "a1",
		trigger: "manual",
		tokensBefore: 4,
	});
	expect(result.entry.summary.coveredMessageIds).toEqual(["u1", "a1"]);
	expect(summaryGenerator).toHaveBeenCalledWith(
		expect.objectContaining({
			focus: "preserve the migration decision",
			model,
		})
	);
});

test("rebuilds the active context from the newest durable compaction", () => {
	const latest: ConversationCompaction = {
		completedAt: new Date("2026-08-30T00:00:00.000Z"),
		createdAt: new Date("2026-08-30T00:00:00.000Z"),
		firstKeptUiMessageId: "u2",
		id: "entry-1",
		sequence: 1,
		sessionId: "session-rebuild",
		summarizationModel: model,
		summary: {
			coveredMessageIds: ["u1", "a1"],
			formatVersion: 1,
			text: "preserve the migration decision",
		},
		throughMessageUiId: "a1",
		tokensAfter: 20,
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
		"compaction:entry-1",
		"u2",
		"a2",
	]);
	expect(active[0]?.parts[0]).toMatchObject({
		text: expect.stringContaining("preserve the migration decision"),
		type: "text",
	});
});

test("repeated compaction passes the prior summary and only the new compacted span", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "new summary" }));
	const compaction = createConversationCompaction({
		generateId: () => "entry-2",
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
		conversation: { messages: initialMessages, sessionId: "session-2" },
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
		conversation: { messages: nextMessages, sessionId: "session-2" },
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

test("summary failure and cancellation do not append durable state", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async ({ signal }: SummaryGeneratorInput) => {
		if (signal?.aborted) {
			throw new Error("aborted");
		}
		throw new Error("provider failed");
	});
	const compaction = createConversationCompaction({
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const conversation = {
		messages: [
			message("u1", "user", "first"),
			message("a1", "assistant", "answer"),
			message("u2", "user", "second"),
			message("a2", "assistant", "answer"),
		],
		sessionId: "session-3",
	};

	await expect(
		compaction.compact({
			conversation,
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "summary-failed" });
	expect(store.appendCompaction).not.toHaveBeenCalled();

	const controller = new AbortController();
	controller.abort();
	await expect(
		compaction.compact({
			conversation,
			model,
			settings,
			trigger: "manual",
			signal: controller.signal,
		})
	).rejects.toMatchObject({ code: "cancelled" });
});

test("persistence failure does not commit a compaction entry", async () => {
	const store = makeStore();
	store.appendCompaction.mockImplementation(async () => {
		throw new Error("disk full");
	});
	const compaction = createConversationCompaction({
		store,
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: (messages) => messages.length,
	});

	await expect(
		compaction.compact({
			conversation: {
				messages: [
					message("u1", "user", "first"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "second"),
					message("a2", "assistant", "answer"),
				],
				sessionId: "session-persistence",
			},
			model,
			settings,
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "persistence-failed" });
	expect(store.appendCompaction).toHaveBeenCalledTimes(1);
});

test("only one compaction operation runs per session", async () => {
	const store = makeStore();
	let release: (() => void) | undefined;
	const summaryGenerator = mock(
		() =>
			new Promise<{ text: string }>((resolve) => {
				release = () => resolve({ text: "summary" });
			})
	);
	const compaction = createConversationCompaction({
		generateId: () => "entry-4",
		store,
		summaryGenerator,
		estimateTokens: (messages) => messages.length,
	});
	const conversation = {
		messages: [
			message("u1", "user", "first"),
			message("a1", "assistant", "answer"),
			message("u2", "user", "second"),
			message("a2", "assistant", "answer"),
		],
		sessionId: "session-4",
	};
	const first = compaction.compact({
		conversation,
		model,
		settings,
		trigger: "manual",
	});
	const second = compaction.compact({
		conversation,
		model,
		settings,
		trigger: "threshold",
	});

	expect(first).toBe(second);
	await Promise.resolve();
	release?.();
	await first;
	expect(summaryGenerator).toHaveBeenCalledTimes(1);
});

test("serializes old attachments as bounded metadata", () => {
	const serialized = serializeMessagesForCompaction([
		{
			id: "u1",
			parts: [
				{
					filename: "design.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${"a".repeat(500)}`,
				},
			],
			role: "user",
		} as unknown as CodingAgentUIMessage,
	]);

	expect(serialized).toContain("design.png");
	expect(serialized).toContain("payloadOmitted");
	expect(serialized).not.toContain("data:image/png;base64");
	expect(serialized.length).toBeLessThan(500);
});

test("splits an oversized single turn only at complete part boundaries", async () => {
	const store = makeStore();
	let serialized = "";
	const compaction = createConversationCompaction({
		generateId: () => "entry-split",
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized = input.serializedMessages;
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = {
		id: "a1",
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "recent suffix", type: "text" },
		],
		role: "assistant",
	} as unknown as CodingAgentUIMessage;

	const result = await compaction.compact({
		conversation: {
			messages: [message("u1", "user", "single request"), assistant],
			sessionId: "session-split",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		"compaction:entry-split",
		"u1",
		"a1",
	]);
	expect(result.activeMessages.at(-1)?.parts).toEqual([
		{ text: "recent suffix", type: "text" },
	]);
	expect(serialized).toContain("prefix one");
	expect(serialized).not.toContain("recent suffix");
});
