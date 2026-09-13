import { expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	type AttachmentMetadataRecord,
	type AttachmentMetadataRepository,
	attachmentReferenceToFilePart,
	createSessionAttachmentStore,
	getAttachmentReference,
} from "../storage/attachment-store";
import {
	createSessionCompaction,
	rebuildActiveMessages,
	serializeMessagesForCompaction,
} from "./compaction";
import { estimateCompactionTokens } from "./config";
import type { SessionCompaction, SummaryGeneratorInput } from "./types";

const model: ChatModelSelection = {
	modelId: "gpt-5.6-luna",
	providerId: "openai",
};
const DATA_IMAGE_URL_PATTERN = /^data:image\/png;base64,/u;

const message = (
	id: string,
	role: SessionMessage["role"],
	text: string
): SessionMessage =>
	fromPartial<SessionMessage>({
		id,
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
	const compaction = createSessionCompaction({
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
		session: { messages, sessionId: "session-1" },
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
				sessionId: "session-short",
			},
			model,
			settings: { enabled: true, keepRecentTokens: 10, thresholdTokens: null },
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
				sessionId: "session-all-recent",
			},
			model,
			settings: { enabled: true, keepRecentTokens: 10, thresholdTokens: null },
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
				sessionId: `session-${trigger}`,
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
	const latest: SessionCompaction = {
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
		estimatedTokensAfter: 1,
		tokensBefore: 2,
		trigger: "manual",
	};

	expect(() =>
		rebuildActiveMessages([message("u1", "user", "current")], latest)
	).toThrow("entry-invalid");
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
		toolCallId: "call-1",
		type: "tool-shell",
	} as const;
	const longTool = {
		...shortTool,
		output: { output: "x".repeat(1000) },
	};
	const shortEstimate = estimateCompactionTokens([
		textOnly,
		fromPartial<SessionMessage>({
			id: "assistant-short",
			parts: [{ text: "thinking", type: "reasoning" }, shortTool],
			role: "assistant",
		}),
	]);
	const longEstimate = estimateCompactionTokens([
		textOnly,
		fromPartial<SessionMessage>({
			id: "assistant-long",
			parts: [{ text: "thinking", type: "reasoning" }, longTool],
			role: "assistant",
		}),
	]);

	expect(shortEstimate).toBeGreaterThan(estimateCompactionTokens([textOnly]));
	expect(longEstimate).toBeGreaterThan(shortEstimate);
	const roleToolEstimate = estimateCompactionTokens([
		textOnly,
		fromAny({
			id: "tool-result",
			parts: [
				{
					output: { output: "x".repeat(1000) },
					toolCallId: "call-1",
					type: "tool-result",
				},
			],
			role: "tool",
		}),
	]);
	expect(roleToolEstimate).toBeGreaterThan(shortEstimate);
});
test("derives one summary attempt from retained context and reserve", async () => {
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
			sessionId: "session-budget",
		},
		model,
		settings: {
			compactionOverheadTokens: 10,
			enabled: true,
			keepRecentTokens: 20,
			modelContextLimit: 330,
			reserveTokens: 800,
			summaryMaxOutputTokens: 4096,
			thresholdTokens: null,
		},
		trigger: "manual",
	});

	expect(summaryGenerator).toHaveBeenCalledTimes(1);
	expect(summaryGenerator.mock.calls[0]?.[0].maxOutputTokens).toBe(300);
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
				sessionId: "session-budget-too-small",
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
	).rejects.toMatchObject({ code: "not-needed" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("repeated compaction passes the prior summary and only the new compacted span", async () => {
	const store = makeStore();
	const summaryGenerator = mock(async () => ({ text: "new summary" }));
	const compaction = createSessionCompaction({
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
		session: { messages: initialMessages, sessionId: "session-2" },
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
		session: { messages: nextMessages, sessionId: "session-2" },
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
				sessionId: "session-expanding",
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
			session: { messages, sessionId: "session-local-acceptance" },
			model,
			settings: { enabled: true, keepRecentTokens: 1, thresholdTokens: null },
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
		sessionId: "session-3",
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
	const compaction = createSessionCompaction({
		generateId: () => "entry-4",
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
		sessionId: "session-4",
	};
	const first = compaction.compact({
		session,
		model,
		settings,
		trigger: "manual",
	});
	const second = compaction.compact({
		session,
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
		fromPartial<SessionMessage>({
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
		}),
	]);

	expect(serialized).toContain("design.png");
	expect(serialized).toContain("payloadBytes");
	expect(serialized).toContain("payloadOmitted");
	expect(serialized).not.toContain("data:image/png;base64");
	expect(serialized.length).toBeLessThan(500);
});

test("hydrates current-window attachments once and persists bounded metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-compaction-attachments-"));
	const attachmentStore = createSessionAttachmentStore({
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
	const imageMessage = fromPartial<SessionMessage>({
		...message("u1", "user", "review [Image 1]"),
		parts: [
			{ text: "review [Image 1]", type: "text" },
			attachmentReferenceToFilePart(reference),
		],
	});
	let summaryMessages: SessionMessage[] | undefined;
	const compaction = createSessionCompaction({
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
		session: {
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
	const compaction = createSessionCompaction({
		store,
		summaryGenerator: async (input) => {
			serialized = input.serializedMessages;
			return { text: "summary" };
		},
		estimateTokens: (messages) => messages.length,
	});
	const skillMessage = fromPartial<SessionMessage>({
		id: "assistant-1",
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
	});

	await compaction.compact({
		session: {
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
	const compaction = createSessionCompaction({
		generateId: () => "entry-split",
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized = input.serializedMessages;
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = fromPartial<SessionMessage>({
		id: "a1",
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
		id: "a1",
		parts: [
			{ text: "prefix", type: "text" },
			{ text: "middle", type: "text" },
			{ text: "suffix", type: "text" },
		],
		role: "assistant",
	});
	const session = {
		messages: [message("u1", "user", "request"), assistant],
		sessionId: "session-split-unchanged",
	};
	const compactionInput = {
		session,
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
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
		generateId: () => "entry-latest-split",
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
		id: "a2",
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
			sessionId: "session-latest-split",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
		trigger: "manual",
	});

	expect(result.activeMessages.map(({ id }) => id)).toEqual([
		"compaction:entry-latest-split",
		"u2",
		"a2",
	]);
	expect(result.activeMessages.at(-1)?.parts).toEqual([
		{ text: "suffix", type: "text" },
	]);
	expect(result.entry.summary.coveredMessageIds).toEqual([
		"u1",
		"a1",
		"u2",
		"a2",
	]);
	expect(serialized).toContain("old request");
});

test("resumes the next summary span after a split-turn boundary", async () => {
	const store = makeStore();
	const serialized: string[] = [];
	const compaction = createSessionCompaction({
		generateId: () => "entry-split",
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized.push(input.serializedMessages);
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const assistant = fromPartial<SessionMessage>({
		id: "a1",
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
			sessionId: "session-split-resume",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
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

test("does not re-summarize a previously split assistant prefix", async () => {
	const store = makeStore();
	const serialized: string[] = [];
	const compaction = createSessionCompaction({
		generateId: () => `entry-${serialized.length + 1}`,
		store,
		summaryGenerator: mock(async (input: SummaryGeneratorInput) => {
			serialized.push(input.serializedMessages);
			return { text: "split summary" };
		}),
		estimateTokens: (messages) =>
			messages.reduce((total, current) => total + current.parts.length, 0),
	});
	const firstAssistant = fromPartial<SessionMessage>({
		id: "a1",
		parts: [
			{ text: "first prefix", type: "text" },
			{ text: "first middle", type: "text" },
			{ text: "first suffix", type: "text" },
		],
		role: "assistant",
	});
	const secondAssistant = fromPartial<SessionMessage>({
		id: "a2",
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
			sessionId: "session-split-twice",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
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
			sessionId: "session-split-twice",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
		trigger: "manual",
	});

	expect(second.entry.summary.coveredMessageIds).toEqual(["a1", "u2", "a2"]);
	expect(serialized[1]).toContain("first suffix");
	expect(serialized[1]).not.toContain("first prefix");
	expect(serialized[1]).toContain("second prefix");
});

test("keeps a split tool call paired with its result", async () => {
	const store = makeStore();
	const toolCall = fromPartial<SessionMessage["parts"][number]>({
		input: { command: "pwd" },
		state: "output-available",
		toolCallId: "call-split",
		type: "tool-shell",
	});
	const assistant = fromPartial<SessionMessage>({
		id: "a1",
		parts: [
			{ text: "prefix", type: "text" },
			toolCall,
			{ text: "suffix", type: "text" },
		],
		role: "assistant",
	});
	const toolResult: SessionMessage = fromAny({
		id: "tool-call-split",
		parts: [
			{
				output: { output: "ok" },
				toolCallId: "call-split",
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
			sessionId: "session-tool-pair",
		},
		model,
		settings: { enabled: true, keepRecentTokens: 4, thresholdTokens: null },

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
		toolCallId: "call-budget",
		type: "tool-shell",
	});
	const assistant = fromPartial<SessionMessage>({
		id: "a1",
		parts: [{ text: "prefix", type: "text" }, toolCall],
		role: "assistant",
	});
	const toolResult: SessionMessage = fromAny({
		id: "tool-call-budget",
		parts: [
			{
				output: { output: "ok" },
				toolCallId: "call-budget",
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
				sessionId: "session-tool-budget",
			},
			model,
			settings: { enabled: true, keepRecentTokens: 2, thresholdTokens: null },
			trigger: "manual",
		})
	).rejects.toMatchObject({ code: "history-too-short" });
	expect(summaryGenerator).not.toHaveBeenCalled();
	expect(store.appendCompaction).not.toHaveBeenCalled();
});

test("projects the newest attachment against the media budget for estimatedTokensAfter", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-compaction-projection-"));
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
	const user = fromPartial<SessionMessage>({
		id: "u1",
		parts: [
			attachmentReferenceToFilePart(oldReference),
			attachmentReferenceToFilePart(newReference),
		],
		role: "user",
	});
	const assistant = fromPartial<SessionMessage>({
		id: "a1",
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
	expect(result.entry.estimatedTokensAfter).toBe(10);
});
