import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatModelSelection } from "@wincode/ai/models";
import { createDatabase } from "./client";
import { createDrizzleConversationStore } from "./drizzle-conversation-store";
import { runMigrations } from "./migrations";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

test("resets conversation data while preserving prompt history", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-conversation-reset-"));
	const databasePath = join(directory, "conversation.sqlite");
	const attachmentRoot = join(directory, "attachments");
	const { db } = createDatabase(databasePath);
	runMigrations(db);
	const store = createDrizzleConversationStore(db, { attachmentRoot });

	const { id: sessionId } = await store.createSession({
		agent: "build",
		message: {
			id: "initial-user",
			parts: [{ text: "hello", type: "text" }],
			role: "user",
		},
		model,
		turnId: "turn-1",
	});
	await store.recordPrompt({ files: [], text: "preserve this prompt" });
	const reference = await store.attachmentStore?.ingest({
		bytes: PNG_BYTES,
		filename: "reset.png",
		mediaType: "image/png",
	});
	if (reference === undefined) {
		throw new Error("The attachment fixture was not stored.");
	}
	await store.appendCompaction({
		firstKeptUiMessageId: "initial-user",
		sessionId,
		summarizationModel: model,
		summary: {
			coveredMessageIds: ["initial-user"],
			formatVersion: 1,
			text: "summary",
		},
		throughMessageUiId: "initial-user",
		tokensBefore: 10,
		estimatedTokensAfter: 5,
		trigger: "manual",
	});

	await store.resetConversationData();

	expect(await store.listSessions()).toEqual([]);
	expect(await store.getPromptHistory()).toEqual([
		{ files: [], text: "preserve this prompt" },
	]);
	expect(await store.getCompactions(sessionId)).toEqual([]);
	expect(await store.attachmentStore?.resolve(reference)).toMatchObject({
		availability: "missing",
	});
	expect(await readdir(attachmentRoot)).toEqual([]);
});

test("repairs an old estimate column during the explicit reset", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-conversation-schema-"));
	const databasePath = join(directory, "conversation.sqlite");
	const attachmentRoot = join(directory, "attachments");
	const { db } = createDatabase(databasePath);
	runMigrations(db);
	db.$client.exec(
		'ALTER TABLE "conversation_compaction" RENAME COLUMN "tokens_after" TO "estimated_tokens_after"'
	);
	const store = createDrizzleConversationStore(db, { attachmentRoot });

	expect(() => store.getCompactions("missing-session")).toThrow(
		"no such column: conversation_compaction.tokens_after"
	);

	await store.resetConversationData();

	const columns = db.$client
		.query("PRAGMA table_info(conversation_compaction)")
		.all() as Array<{ name: string }>;
	expect(columns.map(({ name }) => name)).toContain("tokens_after");
	expect(columns.map(({ name }) => name)).not.toContain(
		"estimated_tokens_after"
	);
	expect(await store.getCompactions("missing-session")).toEqual([]);
});
