import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUndefined } from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import {
	createDatabase,
	SessionDatabaseResetRequiredError,
} from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import { resetLocalSessionData } from "@/modules/sessions/storage/reset-local-session-data";
import { createSessionJsonlStore } from "@/modules/sessions/storage/session-jsonl-store";
import { computeFileVersion } from "@/modules/tools";
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

const createResetPersistence = (
	databasePath: string,
	workspaceRoot: string
) => {
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			attachmentRoot: path.join(path.dirname(databasePath), "attachments"),
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			snapshotRoot: path.join(path.dirname(databasePath), "file-snapshots"),
			workspaceRoot,
		}),
		logRoot
	);
	return {
		close: () => {
			operational.sqlite.close();
			projection.sqlite.close();
		},
		logRoot,
		store,
	};
};

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
	const attachmentLease = await store.attachmentStore?.ingest({
		bytes: PNG_BYTES,
		filename: "reset.png",
		mediaType: "image/png",
	});
	if (isUndefined(attachmentLease)) {
		throw new Error("The attachment fixture was not stored.");
	}
	const reference = attachmentLease.reference;
	await attachmentLease.release();
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
	await store.collectAttachments(0);

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
	expect(await fs.readdir(attachmentRoot)).toEqual(["v1"]);
});
test("reset preserves prompt-history attachment owners and collects unowned Session blobs", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-reset-attachment-owners-")
	);
	const databasePath = path.join(directory, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRoot = path.join(directory, "attachments");
	const snapshotRoot = path.join(directory, "file-snapshots");
	const sessionId = toSessionId("reset-attachment-owner-session");
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
		const promptHistoryLease = await store.attachmentStore?.ingest({
			bytes: PNG_BYTES,
			filename: "prompt-history-owner.png",
			mediaType: "image/png",
		});
		const sessionOnlyLease = await store.attachmentStore?.ingest({
			bytes: new Uint8Array([...PNG_BYTES, 0x01]),
			filename: "session-only-owner.png",
			mediaType: "image/png",
		});
		if (promptHistoryLease === undefined || sessionOnlyLease === undefined) {
			throw new Error("The reset attachment fixtures were not stored.");
		}
		await store.recordPrompt({
			files: [attachmentReferenceToFilePart(promptHistoryLease.reference)],
			text: "prompt history retains its attachment",
		});
		await promptHistoryLease.release();
		await sessionOnlyLease.release();
		const created = await store.createSessionWithExternalizedMessage({
			agent: agentId("build"),
			id: sessionId,
			message: {
				id: sessionMessageId("reset-attachment-owner-message"),
				parts: [
					attachmentReferenceToFilePart(promptHistoryLease.reference),
					attachmentReferenceToFilePart(sessionOnlyLease.reference),
				],
				role: "user",
			},
			model,
			turnId: agentTurnId("reset-attachment-owner-turn"),
		});
		expect(created.writeOutcome.kind).toBe("committed");

		await store.resetSessionData();

		expect(await store.getPromptHistory()).toMatchObject([
			{
				files: [
					{
						attachmentId: promptHistoryLease.reference.attachmentId,
					},
				],
				text: "prompt history retains its attachment",
			},
		]);
		expect(
			await store.attachmentStore?.resolve(promptHistoryLease.reference)
		).toMatchObject({ availability: "available" });
		expect(
			await store.attachmentStore?.resolve(sessionOnlyLease.reference)
		).toMatchObject({ availability: "missing" });
		expect(
			JSON.parse(
				await fs.readFile(
					path.join(
						directory,
						"session-control",
						"deleted",
						`${sessionId}.json`
					),
					"utf8"
				)
			)
		).toMatchObject({ operationId: `delete-${sessionId}`, sessionId });
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("a recovery in one Workspace blocks global reset before any Session log changes", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-reset-workspace-recovery-")
	);
	const databasePath = path.join(directory, "sessions.sqlite");
	const workspaceA = path.join(directory, "workspace-a");
	const workspaceB = path.join(directory, "workspace-b");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const firstSessionId = toSessionId("a-reset-global-session");
	const secondSessionId = toSessionId("b-reset-global-session");
	const first = createResetPersistence(databasePath, workspaceA);
	const second = createResetPersistence(databasePath, workspaceB);
	try {
		await first.store.createEmptySession({ id: firstSessionId });
		await second.store.createEmptySession({ id: secondSessionId });
		const recovery = second.store.fileObservationStore?.recovery;
		if (recovery === undefined) {
			throw new Error("Workspace B has no recovery store.");
		}
		const filePath = path.join(workspaceB, "recovery.txt");
		const originalBytes = new TextEncoder().encode("original\n");
		const changedBytes = new TextEncoder().encode("changed\n");
		await Bun.write(filePath, originalBytes);
		const transaction = await recovery.beginTransaction({
			originSessionId: secondSessionId,
			paths: [
				{
					canonicalPath: filePath,
					displayPath: filePath,
					newFileVersion: computeFileVersion(changedBytes),
					originalBytes,
					originalFileVersion: computeFileVersion(originalBytes),
				},
			],
		});
		await Bun.write(filePath, changedBytes);
		await recovery.createUnresolvedRecovery({
			reason: "Reset must not discard this Workspace recovery.",
			transactionId: transaction.id,
			unresolvedPaths: [filePath],
		});
		const firstLogPath = resolveSessionLogFilePath(
			first.logRoot,
			firstSessionId
		);
		const secondLogPath = resolveSessionLogFilePath(
			second.logRoot,
			secondSessionId
		);
		const firstLogBefore = await Bun.file(firstLogPath).bytes();
		const secondLogBefore = await Bun.file(secondLogPath).bytes();
		const firstMarkerPath = path.join(
			directory,
			"session-control",
			"deleted",
			`${firstSessionId}.json`
		);
		const secondMarkerPath = path.join(
			directory,
			"session-control",
			"deleted",
			`${secondSessionId}.json`
		);

		await expect(first.store.resetSessionData()).rejects.toThrow(
			"Reset is blocked until every workspace recovery is reconciled or discarded."
		);

		expect(await Bun.file(firstLogPath).bytes()).toEqual(firstLogBefore);
		expect(await Bun.file(secondLogPath).bytes()).toEqual(secondLogBefore);
		expect(await Bun.file(firstMarkerPath).exists()).toBe(false);
		expect(await Bun.file(secondMarkerPath).exists()).toBe(false);
		expect(await recovery.listUnresolvedRecoveries()).toHaveLength(1);
	} finally {
		first.close();
		second.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("global reset deletes Sessions bound to different Workspaces without partial failure", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-reset-multi-workspace-")
	);
	const databasePath = path.join(directory, "sessions.sqlite");
	const workspaceA = path.join(directory, "workspace-a");
	const workspaceB = path.join(directory, "workspace-b");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const firstSessionId = toSessionId("a-reset-global-session");
	const secondSessionId = toSessionId("b-reset-global-session");
	const first = createResetPersistence(databasePath, workspaceA);
	const second = createResetPersistence(databasePath, workspaceB);
	try {
		await first.store.createEmptySession({ id: firstSessionId });
		await second.store.createEmptySession({ id: secondSessionId });

		await first.store.resetSessionData();

		for (const sessionId of [firstSessionId, secondSessionId]) {
			expect(
				await Bun.file(
					resolveSessionLogFilePath(first.logRoot, sessionId)
				).exists()
			).toBe(false);
			const markerPath = path.join(
				directory,
				"session-control",
				"deleted",
				`${sessionId}.json`
			);
			expect(await Bun.file(markerPath).json()).toMatchObject({
				operationId: `delete-${sessionId}`,
				sessionId,
			});
		}
		expect(await first.store.listSessions()).toEqual([]);
		expect(await second.store.listSessions()).toEqual([]);
	} finally {
		first.close();
		second.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});

test("reset reports committed cleanup pending and retries the same deletion identity", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-session-reset-cleanup-pending-")
	);
	const databasePath = path.join(directory, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const sessionId = toSessionId("reset-cleanup-pending-session");
	let failRemoval = true;
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			attachmentRoot: path.join(directory, "attachments"),
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			snapshotRoot: path.join(directory, "file-snapshots"),
			workspaceRoot: directory,
		}),
		logRoot,
		{
			remove: async (filePath, options) => {
				if (failRemoval && filePath.endsWith(`${sessionId}.jsonl`)) {
					failRemoval = false;
					throw new Error("Injected reset log removal failure.");
				}
				await fs.rm(filePath, options);
			},
		}
	);
	const markerPath = path.join(
		directory,
		"session-control",
		"deleted",
		`${sessionId}.json`
	);
	try {
		await store.createEmptySession({ id: sessionId });
		await expect(store.resetSessionData()).rejects.toMatchObject({
			code: "session_cleanup_pending",
		});
		expect(await Bun.file(markerPath).exists()).toBe(true);
		expect(
			await fs.stat(resolveSessionLogFilePath(logRoot, sessionId)).then(
				() => true,
				() => false
			)
		).toBe(true);

		await store.resetSessionData();
		expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toMatchObject({
			operationId: `delete-${sessionId}`,
			sessionId,
		});
		expect(await store.listSessions()).toEqual([]);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
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
		const attachmentLease = await store.attachmentStore?.ingest({
			bytes: PNG_BYTES,
			filename: "unsafe-reset.png",
			mediaType: "image/png",
		});
		if (isUndefined(attachmentLease)) {
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
