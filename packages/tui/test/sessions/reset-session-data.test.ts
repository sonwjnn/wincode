import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatModelSelection } from "@wincode/ai/models";
import { isUndefined } from "@wincode/runtime-utils";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

test("resets session data while preserving prompt history", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-session-reset-"));
	const databasePath = join(directory, "session.sqlite");
	const attachmentRoot = join(directory, "attachments");
	const { db } = createDatabase(databasePath);
	const store = createDrizzleSessionStore(db, { attachmentRoot });

	const { id: sessionId } = await store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("initial-user"),
			parts: [{ text: "hello", type: "text" }],
			role: "user",
		},
		model,
		turnId: agentTurnId("turn-1"),
	});
	await store.recordPrompt({ files: [], text: "preserve this prompt" });
	const reference = await store.attachmentStore?.ingest({
		bytes: PNG_BYTES,
		filename: "reset.png",
		mediaType: "image/png",
	});
	if (isUndefined(reference)) {
		throw new Error("The attachment fixture was not stored.");
	}
	await store.appendCompaction({
		firstKeptUiMessageId: sessionMessageId("initial-user"),
		sessionId,
		summarizationModel: model,
		summary: {
			coveredMessageIds: [sessionMessageId("initial-user")],
			formatVersion: 1,
			text: "summary",
		},
		throughMessageUiId: sessionMessageId("initial-user"),
		tokensBefore: 10,
		estimatedTokensAfter: 5,
		trigger: "manual",
	});

	await store.resetSessionData();

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
