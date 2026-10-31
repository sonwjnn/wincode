import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUndefined } from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import {
	createDatabase,
	SessionDatabaseResetRequiredError,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import { resetLocalSessionData } from "@/modules/sessions/storage/reset-local-session-data";
import { createSessionJsonlStore } from "@/modules/sessions/storage/session-jsonl-store";
import { toSessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

const model: ProviderModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

test("resets session data without conflating repeated pasted markers in prompt history", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-reset-")
	);
	const databasePath = path.join(directory, "session.sqlite");
	const attachmentRoot = path.join(directory, "attachments");
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
	const pastedPrompt = {
		files: [],
		pastedText: [
			{ start: 0, text: "first\nsecond\nthird", token: "[Pasted ~3 lines]" },
		],
		text: "[Pasted ~3 lines]",
	};
	await store.recordPrompt(pastedPrompt);
	await store.recordPrompt({
		...pastedPrompt,
		pastedText: [
			{ start: 0, text: "red\ngreen\nblue", token: "[Pasted ~3 lines]" },
		],
	});
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
		{
			...pastedPrompt,
			pastedText: [
				{ start: 0, text: "red\ngreen\nblue", token: "[Pasted ~3 lines]" },
			],
		},
		pastedPrompt,
		{ files: [], text: "preserve this prompt" },
	]);
	expect(await store.getCompactions(sessionId)).toEqual([]);
	expect(await store.attachmentStore?.resolve(reference)).toMatchObject({
		availability: "missing",
	});
	expect(await fs.readdir(attachmentRoot)).toEqual([]);
});
test("manual reset removes authoritative logs before clearing their projection", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-jsonl-reset-")
	);
	const databasePath = path.join(directory, "session.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRoot = path.join(directory, "attachments");
	const snapshotRoot = path.join(directory, "file-snapshots");
	const sessionId = toSessionId("reset-authoritative-session");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			attachmentRoot,
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			snapshotRoot,
			workspaceRoot: directory,
		}),
		logRoot
	);
	try {
		await store.createEmptySession({ id: sessionId });
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}

	await resetLocalSessionData({
		attachmentRoot,
		databasePath,
		snapshotRoot,
		workspaceRoot: directory,
	});

	const resetOperational = createDatabase(databasePath);
	const resetProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const reopened = createSessionJsonlStore(
		createDrizzleSessionStore(resetProjection.db, {
			attachmentRoot,
			operationalDatabase: resetOperational.db,
			sessionLogRoot: logRoot,
			snapshotRoot,
			workspaceRoot: directory,
		}),
		logRoot
	);
	try {
		expect(await reopened.listSessionCatalog()).toEqual({
			issues: [],
			sessions: [],
		});
		expect(await reopened.listSessions()).toEqual([]);
	} finally {
		resetOperational.sqlite.close();
		resetProjection.sqlite.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("incompatible local Session schema is refused without deleting user data", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-incompatible-schema-")
	);
	const databasePath = path.join(directory, "session.sqlite");
	const attachmentRoot = path.join(directory, "attachments");
	const snapshotRoot = path.join(directory, "file-snapshots");
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
				parts: [{ text: "preserve incompatible Session", type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId("unsafe-reset-turn"),
		});
		await store.recordPrompt({ files: [], text: "keep prompt history" });
		await store.appendCompaction({
			firstKeptUiMessageId: sessionMessageId("unsafe-reset-user"),
			sessionId,
			summarizationModel: model,
			summary: {
				coveredMessageIds: [sessionMessageId("unsafe-reset-user")],
				formatVersion: 1,
				text: "preserve incompatible compaction",
			},
			throughMessageUiId: sessionMessageId("unsafe-reset-user"),
			tokensBefore: 10,
			estimatedTokensAfter: 5,
			trigger: "manual",
		});
		const attachment = await store.attachmentStore?.ingest({
			bytes: PNG_BYTES,
			filename: "unsafe-reset.png",
			mediaType: "image/png",
		});
		if (isUndefined(attachment)) {
			throw new Error("The preservation fixture attachment was not stored.");
		}
		const attachmentFiles = await fs.readdir(attachmentRoot);
		sqlite.close();
		sqlite = undefined;

		const incompatibleSchema = new Database(databasePath);
		incompatibleSchema.exec(`
			ALTER TABLE session DROP COLUMN thinking_level;
			ALTER TABLE session_compaction DROP COLUMN summarization_thinking_level;
		`);
		incompatibleSchema.close();

		await expect(
			openSessionServices({
				policy: { cwd: directory, databasePath, workspace: directory },
				sources: {},
			})
		).rejects.toBeInstanceOf(SessionDatabaseResetRequiredError);

		sqlite = new Database(databasePath);
		expect(sqlite.query("SELECT id FROM session").all()).toHaveLength(1);
		expect(
			sqlite.query("SELECT record_id FROM session_record").all()
		).toHaveLength(1);
		expect(
			sqlite.query("SELECT id FROM session_compaction").all()
		).toHaveLength(1);
		expect(sqlite.query("SELECT prompt FROM prompt_history").all()).toEqual([
			{ prompt: "keep prompt history" },
		]);
		expect(await fs.readdir(attachmentRoot)).toEqual(attachmentFiles);
	} finally {
		sqlite?.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});
