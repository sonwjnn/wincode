import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConversationMessageRecord,
	type ConversationRecord,
	isAgentTurnTextPart,
	type OperationalFailure,
} from "@wincode/agent-core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { ChatModelSelection } from "@wincode/ai/models";
import { createDatabase } from "./client";
import { ConversationRecordInvariantError } from "./conversation-record";
import type { ConversationStore } from "./conversation-store";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
import { runMigrations } from "./migrations";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const userMessage = (text: string): CodingAgentUIMessage => ({
	id: "msg-user",
	parts: [{ text, type: "text" }],
	role: "user",
});

const messageRecord = (
	id: string,
	role: "assistant" | "user",
	text: string
): ConversationMessageRecord => ({
	id,
	parts: [{ text, type: "text" }],
	role,
});

const failure: OperationalFailure = {
	code: "unknown",
	message: "The model request failed.",
	retry: "never",
	source: "model",
	version: 1,
};

const completedRecord = (
	id: string,
	messages: ConversationMessageRecord[]
): ConversationRecord => ({
	agentId: "build",
	id,
	messages,
	model: { modelId: "gpt-5.4-mini", providerId: "openai" },
	outcome: {
		finishedAt: 200,
		kind: "completed",
		usage: { inputTokens: 10, outputTokens: 5 },
	},
	turnId: `turn-${id}`,
	version: 1,
});

const failedRecord = (
	id: string,
	messages: ConversationMessageRecord[]
): ConversationRecord => ({
	agentId: "build",
	id,
	messages,
	model: { modelId: "gpt-5.4-mini", providerId: "openai" },
	outcome: { failure, finishedAt: 300, kind: "failed" },
	turnId: `turn-${id}`,
	version: 1,
});
const interruptedRecord = (
	id: string,
	messages: ConversationMessageRecord[]
): ConversationRecord => ({
	agentId: "build",
	id,
	messages,
	model: { modelId: "gpt-5.4-mini", providerId: "openai" },
	outcome: {
		failure: {
			code: "interrupted",
			message: "The Agent Turn was interrupted.",
			retry: "immediate",
			source: "runtime",
			version: 1,
		},
		finishedAt: 400,
		kind: "interrupted",
		reason: "lost-execution",
	},
	turnId: `turn-${id}`,
	version: 1,
});

type TestStore = {
	databasePath: string;
	store: ConversationStore;
};

const createTestStore = async (): Promise<TestStore> => {
	const dir = await mkdtemp(join(tmpdir(), "wincode-conversation-record-"));
	const databasePath = join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	runMigrations(db);
	const store = createDrizzleConversationStore(db, {
		attachmentRoot: join(dir, "attachments"),
	});
	return { databasePath, store };
};

const createSession = async (
	store: ConversationStore,
	text = "hello"
): Promise<string> => {
	const { id } = await store.createSession({
		agent: "build",
		message: userMessage(text),
		model,
	});
	return id;
};

test("round-trips a completed Conversation Record with usage and terminal outcome", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	const record = completedRecord("record-1", [
		messageRecord("msg-user", "user", "hello"),
		messageRecord("msg-assistant", "assistant", "hi there"),
	]);

	await store.commitConversationRecord({ record, sessionId });

	expect(await store.listConversationRecords(sessionId)).toEqual([record]);
});
test("preserves prior committed records before an interrupted turn", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	const prior = completedRecord("record-prior", [
		messageRecord("msg-user", "user", "first"),
		messageRecord("msg-assistant", "assistant", "done"),
	]);
	const interrupted = interruptedRecord("record-lost", [
		messageRecord("msg-user-2", "user", "second"),
	]);

	await store.commitConversationRecord({ record: prior, sessionId });
	await store.commitConversationRecord({ record: interrupted, sessionId });

	expect(await store.listConversationRecords(sessionId)).toEqual([
		prior,
		interrupted,
	]);
});

test("round-trips a failed Conversation Record with its safe failure", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	const record = failedRecord("record-1", [
		messageRecord("msg-user", "user", "hello"),
	]);

	await store.commitConversationRecord({ record, sessionId });

	expect(await store.listConversationRecords(sessionId)).toEqual([record]);
});

test("keeps records isolated per session and per workspace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wincode-conversation-record-"));
	const databasePath = join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	runMigrations(db);
	const firstWorkspace = createDrizzleConversationStore(db, {
		attachmentRoot: join(dir, "attachments-a"),
		workspaceRoot: join(dir, "workspace-a"),
	});
	const secondWorkspace = createDrizzleConversationStore(db, {
		attachmentRoot: join(dir, "attachments-b"),
		workspaceRoot: join(dir, "workspace-b"),
	});
	const sessionA = await createSession(firstWorkspace);
	const sessionB = await createSession(firstWorkspace, "other");

	await firstWorkspace.commitConversationRecord({
		record: completedRecord("record-a", [
			messageRecord("msg-user", "user", "hello"),
		]),
		sessionId: sessionA,
	});

	expect(await firstWorkspace.listConversationRecords(sessionA)).toHaveLength(
		1
	);
	expect(await firstWorkspace.listConversationRecords(sessionB)).toEqual([]);
	// The same session row belongs to the first workspace; the second
	// workspace store must not see or write its records.
	expect(await secondWorkspace.listConversationRecords(sessionA)).toEqual([]);
	await expect(
		secondWorkspace.commitConversationRecord({
			record: completedRecord("record-b", [
				messageRecord("msg-user", "user", "hello"),
			]),
			sessionId: sessionA,
		})
	).rejects.toThrow("Session not found");
});

test("orders committed records by checkpoint commit order", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	const first = completedRecord("record-1", [
		messageRecord("msg-user", "user", "first"),
	]);
	const second = completedRecord("record-2", [
		messageRecord("msg-user", "user", "first"),
		messageRecord("msg-assistant-1", "assistant", "one"),
		messageRecord("msg-user-2", "user", "second"),
	]);
	const third = failedRecord("record-3", [
		messageRecord("msg-user", "user", "first"),
		messageRecord("msg-assistant-1", "assistant", "one"),
		messageRecord("msg-user-2", "user", "second"),
	]);

	await Promise.all([
		store.commitConversationRecord({ record: first, sessionId }),
		store.commitConversationRecord({ record: second, sessionId }),
		store.commitConversationRecord({ record: third, sessionId }),
	]);

	// Each checkpoint lands in one atomic position slot even when the
	// callers fire concurrently.
	expect(await store.listConversationRecords(sessionId)).toEqual([
		first,
		second,
		third,
	]);
});

test("reopens a completed Conversation after closing and reopening the database", async () => {
	const { databasePath, store } = await createTestStore();
	const sessionId = await createSession(store);
	// A completed Conversation is the sequence of committed turn records;
	// later records carry the full committed history of earlier ones.
	const turnOne = completedRecord("record-1", [
		messageRecord("msg-user", "user", "first"),
		messageRecord("msg-assistant-1", "assistant", "one"),
	]);
	const turnTwo = completedRecord("record-2", [
		messageRecord("msg-user", "user", "first"),
		messageRecord("msg-assistant-1", "assistant", "one"),
		messageRecord("msg-user-2", "user", "second"),
		messageRecord("msg-assistant-2", "assistant", "two"),
	]);
	await store.commitConversationRecord({ record: turnOne, sessionId });
	await store.commitConversationRecord({ record: turnTwo, sessionId });

	// Close and reopen the SQLite file with a fresh store.
	{
		const { db } = createDatabase(databasePath);
		runMigrations(db);
		const reopened = createDrizzleConversationStore(db, {
			attachmentRoot: join(tmpdir(), "wincode-reopened-attachments"),
		});
		const records = await reopened.listConversationRecords(sessionId);
		expect(records).toEqual([turnOne, turnTwo]);
		const merged = records.flatMap((record) => record.messages);
		const messages = [
			...new Map(merged.map((message) => [message.id, message])).values(),
		];
		const text = (record: (typeof messages)[number]) =>
			isAgentTurnTextPart(record.parts[0]) ? record.parts[0].text : undefined;
		expect(messages.map(text)).toEqual(["first", "one", "second", "two"]);
	}
});

test("commits atomically: rejected checkpoints leave no partial durable state", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	const valid = completedRecord("record-ok", [
		messageRecord("msg-user", "user", "hello"),
	]);

	// A commit for an unknown session is rejected without side effects.
	await expect(
		store.commitConversationRecord({
			record: valid,
			sessionId: "no-such-session",
		})
	).rejects.toThrow("Session not found");

	// A malformed record is rejected at the interface boundary.
	const malformed = {
		...valid,
		outcome: { finishedAt: 1, kind: "interrupted" },
	} as unknown as ConversationRecord;
	let thrown: unknown;
	try {
		await store.commitConversationRecord({ record: malformed, sessionId });
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(ConversationRecordInvariantError);
	expect(thrown).toMatchObject({
		message: expect.stringContaining("Invalid Conversation Record"),
	});
	if (thrown instanceof ConversationRecordInvariantError) {
		expect(thrown.cause).toBeInstanceOf(Error);
	}

	expect(await store.listConversationRecords(sessionId)).toEqual([]);

	// The same store still commits clean records afterwards.
	await store.commitConversationRecord({ record: valid, sessionId });
	expect(await store.listConversationRecords(sessionId)).toEqual([valid]);
});

test("deletes Conversation Records with their session", async () => {
	const { store } = await createTestStore();
	const sessionId = await createSession(store);
	await store.commitConversationRecord({
		record: completedRecord("record-1", [
			messageRecord("msg-user", "user", "hello"),
		]),
		sessionId,
	});

	await store.deleteSession(sessionId);

	expect(await store.listConversationRecords(sessionId)).toEqual([]);
});
