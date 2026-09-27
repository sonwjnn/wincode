import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChatModelSelection } from "@wincode/ai/models";
import { isUndefined } from "@wincode/runtime-utils";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { resetLocalSessionData } from "@/modules/sessions/storage/reset-local-session-data";
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
const RESET_REQUIRED_PATTERN = /db:reset-sessions/;

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
test("offers an explicit disposable reset after unsafe reasoning reconciliation", async () => {
	const directory = await mkdtemp(
		join("/tmp", "wincode-session-reset-unsafe-migration-")
	);
	const databasePath = join(directory, "session.sqlite");
	const attachmentRoot = join(directory, "attachments");
	const snapshotRoot = join(directory, "file-snapshots");
	let sqlite: Database | undefined;
	try {
		const initial = createDatabase(databasePath);
		sqlite = initial.sqlite;
		const store = createDrizzleSessionStore(initial.db, {
			attachmentRoot,
			snapshotRoot,
			workspaceRoot: directory,
		});
		const { id: sessionId } = await store.createSession({
			agent: agentId("build"),
			message: {
				id: sessionMessageId("unsafe-reset-user"),
				parts: [{ text: "preserve before explicit reset", type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId("unsafe-reset-turn"),
		});
		await store.recordPrompt({ files: [], text: "keep prompt history" });
		const attachment = await store.attachmentStore?.ingest({
			bytes: PNG_BYTES,
			filename: "unsafe-reset.png",
			mediaType: "image/png",
		});
		if (isUndefined(attachment)) {
			throw new Error("The disposable reset attachment was not stored.");
		}
		sqlite.close();
		sqlite = undefined;

		const legacy = new Database(databasePath);
		legacy.exec(`
			ALTER TABLE session DROP COLUMN effort;
			ALTER TABLE session DROP COLUMN reasoning_mode;
			ALTER TABLE session ADD COLUMN variant TEXT;
		`);
		legacy
			.query("UPDATE session SET variant = ? WHERE id = ?")
			.run("unknown-choice", sessionId);
		legacy.close();

		expect(() => createDatabase(databasePath)).toThrow(RESET_REQUIRED_PATTERN);
		await resetLocalSessionData({
			attachmentRoot,
			databasePath,
			snapshotRoot,
			workspaceRoot: directory,
		});

		const reopened = createDatabase(databasePath);
		sqlite = reopened.sqlite;
		const resetStore = createDrizzleSessionStore(reopened.db, {
			attachmentRoot,
			snapshotRoot,
			workspaceRoot: directory,
		});
		expect(await resetStore.listSessions()).toEqual([]);
		expect(await resetStore.getPromptHistory()).toEqual([
			{ files: [], text: "keep prompt history" },
		]);
		expect(await readdir(attachmentRoot)).toEqual([]);
		const columns = sqlite.query("PRAGMA table_info(session)").all() as Array<{
			name: string;
		}>;
		expect(columns.map(({ name }) => name)).not.toContain("variant");
	} finally {
		sqlite?.close();
		await rm(directory, { force: true, recursive: true });
	}
});
