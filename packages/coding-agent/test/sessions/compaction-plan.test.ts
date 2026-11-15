import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { planCompaction } from "@/modules/sessions/compaction/compaction";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	compactionId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";
import { makeSessionMessage as message } from "../support/session-message";

test("a plan exposes the ordinary summary boundary and retained Session Context", () => {
	const messages = [
		message("u1", "user", "older request"),
		message("a1", "assistant", "older answer"),
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
	];

	const plan = planCompaction({
		messages,
		previousCompaction: null,
		keepRecentTokens: 2,
		estimateTokens: (candidate) => candidate.length,
	});

	expect(plan.boundary).toEqual({
		firstKeptIndex: 2,
		firstKeptUiMessageId: sessionMessageId("u2"),
		throughIndex: 1,
		throughMessageUiId: sessionMessageId("a1"),
	});
	expect(plan.summaryMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(plan.coveredMessageIds).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
	]);
	expect(plan.retainedMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("u2"),
		sessionMessageId("a2"),
	]);
	expect(plan.summaryRecipe).toEqual({ kind: "ordinary" });
	expect(plan.previousCompaction).toBeNull();
});

test("a split-turn plan separates older history from the current turn prefix", () => {
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("split-assistant"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "retained suffix", type: "text" },
		],
		role: "assistant",
	});
	const messages = [
		message("old-user", "user", "older request"),
		message("old-assistant", "assistant", "older answer"),
		message("current-user", "user", "current request"),
		assistant,
	];

	const plan = planCompaction({
		messages,
		previousCompaction: null,
		keepRecentTokens: 2,
		estimateTokens: (candidate) =>
			candidate.reduce((total, current) => total + current.parts.length, 0),
	});

	expect(plan.boundary).toMatchObject({
		firstKeptUiMessageId: sessionMessageId("current-user"),
		firstKeptAssistantPartIndex: 2,
		throughMessageUiId: sessionMessageId("split-assistant"),
	});
	expect(plan.retainedMessages.at(-1)?.parts).toEqual([
		{ text: "retained suffix", type: "text" },
	]);
	expect(plan.summaryMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("old-user"),
		sessionMessageId("old-assistant"),
		sessionMessageId("current-user"),
		sessionMessageId("split-assistant"),
	]);
	expect(plan.summaryMessages.at(-1)?.parts).toEqual([
		{ text: "prefix one", type: "text" },
		{ text: "prefix two", type: "text" },
	]);
	expect(plan.summaryRecipe).toMatchObject({
		kind: "split-with-history",
		history: [messages[0], messages[1]],
		turnPrefix: [
			messages[2],
			{
				...assistant,
				parts: assistant.parts.slice(0, 2),
			},
		],
	});
});

test("a split without older history records the no-history fallback", () => {
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("single-turn-assistant"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "retained suffix", type: "text" },
		],
		role: "assistant",
	});
	const user = message("only-user", "user", "current request");
	const messages = [user, assistant];

	const plan = planCompaction({
		messages,
		previousCompaction: null,
		keepRecentTokens: 2,
		estimateTokens: (candidate) =>
			candidate.reduce((total, current) => total + current.parts.length, 0),
	});

	expect(plan.summaryRecipe).toEqual({
		kind: "split-without-history",
		turnPrefix: [user, { ...assistant, parts: assistant.parts.slice(0, 2) }],
		historyFallback: { kind: "no-prior-history" },
	});
});

test("a split without new history carries the previous summary as its fallback", () => {
	const previousCompaction = fromPartial<SessionCompaction>({
		firstKeptUiMessageId: sessionMessageId("current-user"),
		id: compactionId("previous-compaction"),
		summary: {
			coveredMessageIds: [
				sessionMessageId("old-user"),
				sessionMessageId("old-assistant"),
			],
			formatVersion: 1,
			text: "Previous durable handoff.",
		},
		throughMessageUiId: sessionMessageId("old-assistant"),
	});
	const assistant = fromPartial<SessionMessage>({
		id: sessionMessageId("split-assistant"),
		parts: [
			{ text: "prefix one", type: "text" },
			{ text: "prefix two", type: "text" },
			{ text: "retained suffix", type: "text" },
		],
		role: "assistant",
	});
	const messages = [
		message("old-user", "user", "older request"),
		message("old-assistant", "assistant", "older answer"),
		message("current-user", "user", "current request"),
		assistant,
	];

	const plan = planCompaction({
		messages,
		previousCompaction,
		keepRecentTokens: 2,
		estimateTokens: (candidate) =>
			candidate.reduce((total, current) => total + current.parts.length, 0),
	});

	expect(plan.previousCompaction).toBe(previousCompaction);
	expect(plan.summaryRecipe).toMatchObject({
		kind: "split-without-history",
		historyFallback: {
			kind: "previous-summary",
			text: "Previous durable handoff.",
		},
	});
});

test("a plan is deterministic and does not mutate its transcript input", () => {
	const messages = [
		message("u1", "user", "older request"),
		message("a1", "assistant", "older answer"),
		message("u2", "user", "current request"),
		message("a2", "assistant", "current answer"),
	];
	const originalMessages = structuredClone(messages);
	const input = {
		messages,
		previousCompaction: null,
		keepRecentTokens: 2,
		estimateTokens: (candidate: readonly SessionMessage[]) => candidate.length,
	};

	const first = planCompaction(input);
	const second = planCompaction(input);

	expect(first).toEqual(second);
	expect(messages).toEqual(originalMessages);
});

test("a plan carries cumulative file operations across the previous boundary", () => {
	const previousCompaction = fromPartial<SessionCompaction>({
		firstKeptUiMessageId: sessionMessageId("u2"),
		id: compactionId("previous-file-summary"),
		summary: {
			coveredMessageIds: [sessionMessageId("u1"), sessionMessageId("a1")],
			fileOperations: {
				modified: ["src/changed.ts"],
				read: ["src/old.ts"],
			},
			formatVersion: 1,
			text: "Earlier summary.",
		},
		throughMessageUiId: sessionMessageId("a1"),
	});
	const readMessage = fromPartial<SessionMessage>({
		id: sessionMessageId("read-new-file"),
		parts: [
			{
				output: {
					content: "1 | new file",
					fileVersion: "a".repeat(32),
					path: "src/new.ts",
				},
				state: "output-available",
				toolCallId: toolCallId("read-new-file"),
				type: "tool-read",
			},
		],
		role: "assistant",
	});

	const originalPrevious = structuredClone(previousCompaction);
	const plan = planCompaction({
		messages: [
			message("u1", "user", "older request"),
			message("a1", "assistant", "older answer"),
			message("u2", "user", "second request"),
			readMessage,
			message("u3", "user", "current request"),
			message("a3", "assistant", "current answer"),
		],
		previousCompaction,
		keepRecentTokens: 2,
		estimateTokens: (candidate) => candidate.length,
	});

	expect(plan.fileOperations).toEqual({
		modified: ["src/changed.ts"],
		read: ["src/new.ts", "src/old.ts"],
	});
	expect(plan.summaryMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("u2"),
		sessionMessageId("read-new-file"),
	]);
	expect(previousCompaction).toEqual(originalPrevious);
});

test("a protected continuation remains retained even when it exceeds the recent-token budget", () => {
	const messages = [
		message("old-user", "user", "older request"),
		message("old-assistant", "assistant", "older answer"),
		message("current-user", "user", "continuation request"),
		message("current-assistant", "assistant", "continuation response"),
	];

	const plan = planCompaction({
		messages,
		previousCompaction: null,
		keepRecentTokens: 1,
		estimateTokens: (candidate) => candidate.length,
		protectedMessageIds: [
			sessionMessageId("current-user"),
			sessionMessageId("current-assistant"),
		],
	});

	expect(plan.coveredMessageIds).toEqual([
		sessionMessageId("old-user"),
		sessionMessageId("old-assistant"),
	]);
	expect(plan.retainedMessages.map(({ id }) => id)).toEqual([
		sessionMessageId("current-user"),
		sessionMessageId("current-assistant"),
	]);
});

test("a missing protected continuation keeps the existing invalid-boundary error", () => {
	let failure: unknown;
	try {
		planCompaction({
			messages: [
				message("u1", "user", "older request"),
				message("a1", "assistant", "older answer"),
				message("u2", "user", "current request"),
				message("a2", "assistant", "current answer"),
			],
			previousCompaction: null,
			keepRecentTokens: 2,
			estimateTokens: (candidate) => candidate.length,
			protectedMessageIds: [sessionMessageId("missing-protected-message")],
		});
	} catch (error) {
		failure = error;
	}

	expect(failure).toMatchObject({ code: "invalid-boundary" });
});
