import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentTurnOutcomeRecord,
	ConversationMessageRecord,
	ConversationRecord,
	OperationalFailure,
} from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { ConversationMessage } from "@/modules/conversations/message";
import { createDatabase } from "./client";
import {
	buildUserConversationRecord,
	ConversationRecordInvariantError,
	projectConversationRecords,
} from "./conversation-record";
import type { ConversationStore } from "./conversation-store";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
import { runMigrations } from "./migrations";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const userMessage = (text: string, id = "msg-user"): ConversationMessage => ({
	id,
	parts: [{ text, type: "text" }],
	role: "user",
});

const messageRecord = (
	id: string,
	role: "assistant" | "user",
	text: string,
	metadata?: ConversationMessageRecord["metadata"]
): ConversationMessageRecord => ({
	id,
	...(metadata === undefined ? {} : { metadata }),
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

const assistantRecord = (
	id: string,
	text: string,
	terminal: AgentTurnOutcomeRecord = {
		finishedAt: 200,
		kind: "completed",
		usage: { inputTokens: 10, outputTokens: 5 },
	}
): ConversationRecord => ({
	agentId: "build",
	id,
	messages: [
		messageRecord(id.replace("record", "assistant"), "assistant", text, {
			agent: "build",
			model,
		}),
	],
	model,
	outcome: { kind: "assistant", terminal },
	turnId: `turn-${id}`,
	version: 1,
});

const failedRecord = (id: string): ConversationRecord =>
	assistantRecord(id, failure.message, {
		failure,
		finishedAt: 300,
		kind: "failed",
	});

const cancelledRecord = (id: string): ConversationRecord =>
	assistantRecord(id, "The Agent Turn was cancelled.", {
		failure: {
			code: "cancelled",
			message: "The Agent Turn was cancelled.",
			retry: "never",
			source: "runtime",
			version: 1,
		},
		finishedAt: 400,
		kind: "cancelled",
	});

const toolRecord = (id: string): ConversationRecord => ({
	agentId: "build",
	id,
	messages: [
		{
			id: `tool-${id}`,
			parts: [
				{
					input: { command: "git status" },
					outcome: { kind: "success", output: { exitCode: 0 } },
					sequence: 1,
					toolCallId: `call-${id}`,
					toolName: "shell",
					type: "tool-call",
				},
			],
			role: "assistant",
		},
	],
	model,
	outcome: { kind: "tool" },
	turnId: `turn-${id}`,
	version: 1,
});

type TestStore = {
	databasePath: string;
	store: ConversationStore;
};

type CreatedSession = {
	id: string;
	initialRecord: ConversationRecord;
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
): Promise<CreatedSession> => {
	const { id } = await store.createSession({
		agent: "build",
		message: userMessage(text),
		model,
		turnId: `turn-initial-${text}`,
	});
	const [initialRecord] = await store.listConversationRecords(id);
	if (initialRecord === undefined) {
		throw new Error("The initial user record was not persisted.");
	}
	return { id, initialRecord };
};

test("persists the accepted user message as an ordinary record", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store, "first");

	expect(initialRecord.outcome).toEqual({ kind: "user" });
	expect(initialRecord.messages).toEqual([
		{
			id: "msg-user",
			parts: [{ text: "first", type: "text" }],
			role: "user",
		},
	]);
	expect(await store.listConversationRecords(id)).toEqual([initialRecord]);
});

test("reopens durable records without reconstructing or running execution", async () => {
	const { databasePath, store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const assistant = assistantRecord("record-assistant", "done");
	await store.commitConversationRecord({ record: assistant, sessionId: id });

	const { db } = createDatabase(databasePath);
	runMigrations(db);
	const reopened = createDrizzleConversationStore(db, {
		attachmentRoot: join(tmpdir(), "wincode-reopened-attachments"),
	});

	expect(await reopened.listConversationRecords(id)).toEqual([
		initialRecord,
		assistant,
	]);
});

test("round-trips assistant and tool records independently", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const tool = toolRecord("record-tool");
	const assistant = assistantRecord("record-assistant", "tool result");

	await store.commitConversationRecord({ record: tool, sessionId: id });
	await store.commitConversationRecord({ record: assistant, sessionId: id });

	expect(await store.listConversationRecords(id)).toEqual([
		initialRecord,
		tool,
		assistant,
	]);
});

test("round-trips delegated correlation independently from the parent turn", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record: ConversationRecord = {
		...assistantRecord("record-subagent", "delegated result"),
		agentId: "research",
		delegation: { parentToolCallId: "call-1", parentTurnId: "turn-parent" },
	};

	await store.commitConversationRecord({ record, sessionId: id });

	expect(await store.listConversationRecords(id)).toEqual([
		initialRecord,
		record,
	]);
});

test("round-trips a failed assistant record with its safe failure", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record = failedRecord("record-failed");

	await store.commitConversationRecord({ record, sessionId: id });

	expect(await store.listConversationRecords(id)).toEqual([
		initialRecord,
		record,
	]);
});

test("round-trips a cancelled assistant record without an interrupted badge", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record = cancelledRecord("record-cancelled");

	await store.commitConversationRecord({ record, sessionId: id });

	expect(await store.listConversationRecords(id)).toEqual([
		initialRecord,
		record,
	]);
	expect(projectConversationRecords([record])[0]?.metadata).toEqual({
		agent: "build",
		model,
		terminalOutcome: "cancelled",
	});
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
		record: assistantRecord("record-a", "hello"),
		sessionId: sessionA.id,
	});

	expect(
		await firstWorkspace.listConversationRecords(sessionA.id)
	).toHaveLength(2);
	expect(
		await firstWorkspace.listConversationRecords(sessionB.id)
	).toHaveLength(1);
	expect(await secondWorkspace.listConversationRecords(sessionA.id)).toEqual(
		[]
	);
	await expect(
		secondWorkspace.commitConversationRecord({
			record: assistantRecord("record-b", "hello"),
			sessionId: sessionA.id,
		})
	).rejects.toThrow("Session not found");
});

test("orders concurrently committed records by their allocated position", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const first = assistantRecord("record-1", "one");
	const second = assistantRecord("record-2", "two");
	const third = failedRecord("record-3");

	await Promise.all([
		store.commitConversationRecord({ record: first, sessionId: id }),
		store.commitConversationRecord({ record: second, sessionId: id }),
		store.commitConversationRecord({ record: third, sessionId: id }),
	]);

	expect(await store.listConversationRecords(id)).toEqual([
		initialRecord,
		first,
		second,
		third,
	]);
});

test("rejects malformed records without partial durable state", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const malformed = {
		...assistantRecord("record-invalid", "bad"),
		outcome: { kind: "assistant", terminal: { finishedAt: 1, kind: "failed" } },
	} as unknown as ConversationRecord;

	await expect(
		store.commitConversationRecord({ record: malformed, sessionId: id })
	).rejects.toBeInstanceOf(ConversationRecordInvariantError);
	expect(await store.listConversationRecords(id)).toEqual([initialRecord]);

	await store.commitConversationRecord({
		record: assistantRecord("record-valid", "good"),
		sessionId: id,
	});
	expect(await store.listConversationRecords(id)).toHaveLength(2);
});

test("deletes Conversation Records with their session", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
	await store.commitConversationRecord({
		record: assistantRecord("record-1", "hello"),
		sessionId: id,
	});

	await store.deleteSession(id);

	expect(await store.listConversationRecords(id)).toEqual([]);
});

test("projects each ordinary row with references, metadata, and stable delegation ids", () => {
	const attachmentId = `v1-${"a".repeat(64)}`;
	const userRecord: ConversationRecord = {
		agentId: "build",
		id: "record-user",
		messages: [
			{
				id: "user-1",
				metadata: {
					agent: "build",
					model,
					skill: {
						arguments: "focus",
						contentHash: "hash-1",
						name: "review",
						source: "explicit",
					},
				},
				parts: [
					{ text: "Review this file", type: "text" },
					{
						attachmentId,
						byteLength: 3,
						filename: "notes.txt",
						mediaType: "text/plain",
						type: "attachment-reference",
					},
					{
						data: {
							byteLength: 5,
							content: "const x = 1;",
							kind: "file",
							path: "src/index.ts",
							truncated: false,
						},
						type: "file-mention",
					},
				],
				role: "user",
			},
		],
		model,
		outcome: { kind: "user" },
		turnId: "turn-user",
		version: 1,
	};
	const delegated = {
		...assistantRecord("record-delegated", "delegated result"),
		agentId: "research",
		delegation: { parentToolCallId: "call-1", parentTurnId: "turn-parent" },
	};
	const primaryAssistant = assistantRecord("record-primary", "parent result");

	const projected = projectConversationRecords([
		userRecord,
		delegated,
		primaryAssistant,
	]);
	const [user, , delegatedAssistant] = projected;
	expect(projected.map(({ id }) => id)).toEqual([
		"user-1",
		"assistant-primary",
		"delegated-turn:turn-record-delegated:0:assistant-delegated",
	]);
	expect(user).toMatchObject({
		id: "user-1",
		metadata: {
			agent: "build",
			model,
			skill: {
				arguments: "focus",
				contentHash: "hash-1",
				name: "review",
				source: "explicit",
			},
		},
	});
	expect(user?.parts).toContainEqual({
		attachmentId,
		byteLength: 3,
		filename: "notes.txt",
		mediaType: "text/plain",
		type: "file",
		url: `attachment://${attachmentId}`,
	});
	expect(user?.parts).toContainEqual({
		data: {
			byteLength: 5,
			content: "const x = 1;",
			kind: "file",
			path: "src/index.ts",
			truncated: false,
		},
		type: "data-fileMention",
	});
	expect(delegatedAssistant?.id).toBe(
		"delegated-turn:turn-record-delegated:0:assistant-delegated"
	);
});

test("persists delegated child prompts as correlated user rows", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
	const delegation = {
		parentToolCallId: "call-parent",
		parentTurnId: "turn-parent",
	};
	const record = buildUserConversationRecord({
		agentId: "subagent",
		delegation,
		message: userMessage("child prompt", "child-user"),
		model,
		turnId: "child-turn",
	});

	await store.commitConversationRecord({ record, sessionId: id });

	expect(await store.listConversationRecords(id)).toContainEqual(record);
	expect(projectConversationRecords([record])).toEqual([
		{
			id: "delegated-turn:child-turn:0:child-user",
			metadata: { agent: "subagent", model },
			parts: [{ text: "child prompt", type: "text" }],
			role: "user",
		},
	]);
});

test("projects a failed assistant row as its safe transcript message", () => {
	const projected = projectConversationRecords([failedRecord("record-failed")]);

	expect(projected).toEqual([
		{
			id: "assistant-failed",
			metadata: {
				agent: "build",
				model,
				terminalOutcome: "failed",
			},
			parts: [{ text: failure.message, type: "text" }],
			role: "assistant",
		},
	]);
});
