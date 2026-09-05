import { expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { ConversationMessage } from "@/modules/conversations/message";
import {
	type AttachmentMetadataRecord,
	type AttachmentMetadataRepository,
	attachmentReferenceToFilePart,
	createConversationAttachmentStore,
	getAttachmentReference,
} from "../storage/attachment-store";
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
const DATA_IMAGE_URL_PATTERN = /^data:image\/png;base64,/u;

const message = (
	id: string,
	role: ConversationMessage["role"],
	text: string
): ConversationMessage =>
	({
		id,
		parts: [{ text, type: "text" }],
		role,
	}) as ConversationMessage;

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

test("fails closed when a durable compaction boundary is missing", () => {
	const latest: ConversationCompaction = {
		completedAt: new Date("2026-08-30T00:00:00.000Z"),
		createdAt: new Date("2026-08-30T00:00:00.000Z"),
		firstKeptUiMessageId: "missing-message",
		id: "entry-invalid",
		sequence: 2,
		sessionId: "session-invalid",
		summarizationModel: model,
		summary: {
			coveredMessageIds: ["old-message"],
			formatVersion: 1,
			text: "summary",
		},
		throughMessageUiId: "old-message",
		tokensAfter: 1,
		tokensBefore: 2,
		trigger: "manual",
	};

	expect(() =>
		rebuildActiveMessages([message("u1", "user", "current")], latest)
	).toThrow("entry-invalid");
});

test("uses provider-reported usage for threshold decisions", () => {
	const compaction = createConversationCompaction({
		store: makeStore(),
		summaryGenerator: async () => ({ text: "summary" }),
		estimateTokens: () => 1,
	});
	const assistant = message("a1", "assistant", "answer");
	const messages: ConversationMessage[] = [
		message("u1", "user", "request"),
		{
			...assistant,
			metadata: {
				model,
				usage: { inputTokens: 90, outputTokens: 20 },
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
		} as unknown as ConversationMessage,
	]);

	expect(serialized).toContain("design.png");
	expect(serialized).toContain("payloadBytes");
	expect(serialized).toContain("payloadOmitted");
	expect(serialized).not.toContain("data:image/png;base64");
	expect(serialized.length).toBeLessThan(500);
});

test("hydrates current-window attachments once and persists bounded metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-compaction-attachments-"));
	const attachmentStore = createConversationAttachmentStore({
		repository: createAttachmentRepository(),
		root,
	});
	const reference = await attachmentStore.ingest({
		bytes: new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
		]),
		filename: "design.png",
		mediaType: "image/png",
	});
	const imageMessage = {
		...message("u1", "user", "review [Image 1]"),
		parts: [
			{ text: "review [Image 1]", type: "text" },
			attachmentReferenceToFilePart(reference),
		],
	} as unknown as ConversationMessage;
	let summaryMessages: ConversationMessage[] | undefined;
	const compaction = createConversationCompaction({
		attachmentStore,
		store: makeStore(),
		summaryGenerator: async (input) => {
			summaryMessages = input.summaryMessages;
			return { text: "image summary data:image/png;base64,aG Vs\nbG8=." };
		},
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});

	const result = await compaction.compact({
		conversation: {
			messages: [
				imageMessage,
				message("a1", "assistant", "noted"),
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: "session-attachments",
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 2,
			maxMediaAttachments: 1,
			maxMediaBytes: 10_000,
			maxMediaTokens: 10_000,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	expect(summaryMessages?.[0]?.parts[1]).toMatchObject({
		url: expect.stringMatching(DATA_IMAGE_URL_PATTERN),
	});
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
	const compaction = createConversationCompaction({
		store,
		summaryGenerator: async (input) => {
			serialized = input.serializedMessages;
			return { text: "summary" };
		},
		estimateTokens: (messages) => messages.length,
	});
	const skillMessage = {
		id: "a1",
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
				toolCallId: "skill-1",
				toolName: "skill",
				type: "dynamic-tool",
			},
		],
		role: "assistant",
	} as unknown as ConversationMessage;

	await compaction.compact({
		conversation: {
			messages: [
				message("u1", "user", "load review"),
				skillMessage,
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: "session-skill",
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
				sessionId: "session-too-large",
			},
			model,
			settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: 2 },
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "context-still-too-large" });
	expect(store.appendCompaction).not.toHaveBeenCalled();
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
	} as unknown as ConversationMessage;

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

test("resumes the next summary span after a split-turn boundary", async () => {
	const store = makeStore();
	const serialized: string[] = [];
	const compaction = createConversationCompaction({
		generateId: () => "entry-split",
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized.push(input.serializedMessages);
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
	} as unknown as ConversationMessage;

	const first = await compaction.compact({
		conversation: {
			messages: [message("u1", "user", "single request"), assistant],
			sessionId: "session-split-resume",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
		trigger: "manual",
	});
	expect(first.entry.firstKeptAssistantPartIndex).toBe(2);

	const second = await compaction.compact({
		conversation: {
			messages: [
				message("u1", "user", "single request"),
				assistant,
				message("u2", "user", "continue"),
				message("a2", "assistant", "done"),
			],
			sessionId: "session-split-resume",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
		trigger: "manual",
	});
	expect(second.entry.firstKeptUiMessageId).toBe("u2");
	expect(serialized.at(-1)).toContain("recent suffix");
	expect(serialized.at(-1)).not.toContain("single request");
});

test("projects the newest attachment against the media budget for tokensAfter", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-compaction-projection-"));
	const attachmentStore = createConversationAttachmentStore({
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
	const compaction = createConversationCompaction({
		attachmentStore,
		generateId: () => "entry-projection",
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
	const user = {
		id: "u1",
		parts: [
			attachmentReferenceToFilePart(oldReference),
			attachmentReferenceToFilePart(newReference),
		],
		role: "user",
	} as unknown as ConversationMessage;
	const assistant = {
		id: "a1",
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "recent suffix", type: "text" },
		],
		role: "assistant",
	} as unknown as ConversationMessage;

	const result = await compaction.compact({
		conversation: {
			messages: [user, assistant],
			sessionId: "session-projection",
		},
		model,
		settings: {
			enabled: true,
			keepRecentTokens: 10,
			maxMediaAttachments: 1,
			maxMediaBytes: 10_000,
			maxMediaTokens: 10_000,
			thresholdTokens: null,
		},
		trigger: "manual",
	});
	// Newest (large) attachment is retained: summary(1) + marker(1) +
	// ceil(5010/1000)+1(7) + suffix(1) = 10. Charging oldest-first would omit
	// the large attachment and report 5 instead.
	expect(result.entry.tokensAfter).toBe(10);
});
