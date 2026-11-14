import type { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { resolveTurnTools } from "@/modules/sessions/hooks/runtime-turn";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { fileLease } from "@/modules/sessions/storage/schema";
import type { SessionProjectionStore } from "@/modules/sessions/storage/session-store";
import {
	createDrizzleFileObservationStore,
	type FileObservationClock,
} from "@/modules/sessions/storage/versioned-editing-store";
import {
	CodingToolError,
	computeFileVersion,
	FILE_VERSION_ALGORITHM,
	type FileObservationStore,
	type FileSnapshot,
	type FileVersion,
	getToolResourceLimits,
	type VersionedEditingContext,
} from "@/modules/tools";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

type OpenedSessionStore = {
	database: { sqlite: SqliteDatabase };
	store: SessionProjectionStore;
};

const model = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
} as const;

const openStore = (root: string, databasePath: string): OpenedSessionStore => {
	const database = createDatabase(databasePath);
	const store = createDrizzleSessionStore(database.db, {
		attachmentRoot: path.join(root, "attachments"),
		snapshotRoot: path.join(root, "snapshots"),
		workspaceRoot: root,
	});
	return { database, store };
};

const observationStoreFor = (
	store: SessionProjectionStore
): FileObservationStore => {
	if (store.fileObservationStore === undefined) {
		throw new Error("The session store has no file observation store.");
	}
	return store.fileObservationStore;
};
const createTools = async (
	context: VersionedEditingContext,
	resourceLimits = getToolResourceLimits()
) => {
	const tools = await resolveTurnTools({
		agentTools: ["read", "write", "edit", "recover"],
		resourceLimits,
		versionedEditing: context,
	});
	return {
		find(name: "edit" | "read" | "recover" | "write") {
			const tool = tools.find(
				(candidate) => candidate.definition.name === name
			);
			if (tool === undefined) {
				throw new Error(`Missing ${name} coding tool.`);
			}
			return tool;
		},
	};
};

test("persists observations and edit modes across restart", async () => {
	const root = await fs.mkdtemp(
		path.join(process.cwd(), ".wincode-versioned-editing-")
	);
	const databasePath = path.join(root, "sessions.sqlite");
	const filePath = path.join(root, "note.txt");
	let activeDatabase: OpenedSessionStore["database"] | undefined;
	try {
		await Bun.write(filePath, "one\ntwo\n");
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		let store = opened.store;
		const { id: sessionId } = await store.createSession({
			agent: agentId("build"),
			message: {
				id: sessionMessageId("initial-user"),
				parts: [{ text: "edit the note", type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId("turn-initial"),
		});
		const context = (): VersionedEditingContext => ({
			editMode: "hashline",
			sessionId,
			store: observationStoreFor(store),
		});
		const tools = await createTools(context());
		const readResult = await tools
			.find("read")
			.execute(
				{ input: { path: filePath }, toolCallId: toolCallId("read-initial") },
				{}
			);
		if (readResult.type !== "success") {
			throw new Error(readResult.errorText);
		}
		const readOutput = readResult.output as {
			fileVersion: FileVersion;
			observationId: string;
		};
		expect(readOutput.observationId).toBeString();
		expect(
			await context().store.getObservation(
				sessionId,
				filePath,
				readOutput.fileVersion
			)
		).not.toBeNull();
		expect(
			await context().store.getSnapshot(filePath, readOutput.fileVersion)
		).not.toBeNull();
		const artifact = {
			byteLength: 4,
			content: "diff",
			createdAt: Date.now(),
			id: "artifact-restart",
			sessionId,
		};
		await context().store.saveFullDiffArtifact?.(artifact);

		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		store = reopened.store;
		expect(await store.getEditMode?.(sessionId)).toBe("hashline");
		const restartedContext = (): VersionedEditingContext => ({
			editMode: "hashline",
			sessionId,
			store: observationStoreFor(store),
		});
		expect(
			await restartedContext().store.getObservation(
				sessionId,
				filePath,
				readOutput.fileVersion
			)
		).not.toBeNull();
		expect(
			await restartedContext().store.getFullDiffArtifact?.(
				sessionId,
				artifact.id
			)
		).toEqual(artifact);
		const restartedTools = await createTools(restartedContext());
		const mismatchResult = await restartedTools.find("edit").execute(
			{
				input: {
					mode: "replace",
					newString: "ONE",
					oldString: "one",
					path: filePath,
				},
				toolCallId: toolCallId("edit-wrong-mode"),
			},
			{}
		);
		expect(mismatchResult).toMatchObject({
			failure: { code: "edit-mode-mismatch" },
			type: "failure",
		});
		const editResult = await restartedTools.find("edit").execute(
			{
				input: {
					patch: `[${filePath}#${readOutput.fileVersion}]\nPUT 1.=1:\n+ONE`,
				},
				toolCallId: toolCallId("edit-restarted"),
			},
			{}
		);
		if (editResult.type !== "success") {
			throw new Error(editResult.errorText);
		}
		expect(await Bun.file(filePath).text()).toBe("ONE\ntwo\n");
		await store.setEditMode?.(sessionId, "sloppy");

		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		const reopenedAgain = openStore(root, databasePath);
		activeDatabase = reopenedAgain.database;
		store = reopenedAgain.store;
		expect(await store.getEditMode?.(sessionId)).toBe("sloppy");
		const sloppyContext: VersionedEditingContext = {
			editMode: "sloppy",
			sessionId,
			store: observationStoreFor(store),
		};
		const sloppyTools = await createTools(sloppyContext);
		const sloppyResult = await sloppyTools.find("edit").execute(
			{
				input: {
					mode: "sloppy",
					patch: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-ONE\n+DONE\n*** End Patch`,
				},
				toolCallId: toolCallId("edit-sloppy"),
			},
			{}
		);
		if (sloppyResult.type !== "success") {
			throw new Error(sloppyResult.errorText);
		}
		expect(await Bun.file(filePath).text()).toBe("DONE\ntwo\n");

		const newFilePath = path.join(root, "nested", "created.txt");
		const writeResult = await sloppyTools.find("write").execute(
			{
				input: {
					content: "created\n",
					expectedVersion: null,
					path: newFilePath,
				},
				toolCallId: toolCallId("write-new"),
			},
			{}
		);
		if (writeResult.type !== "success") {
			throw new Error(writeResult.errorText);
		}
		expect(await Bun.file(newFilePath).text()).toBe("created\n");
	} finally {
		activeDatabase?.sqlite.close();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("smoke: multi-file artifacts, restart recovery, and a later edit", async () => {
	const root = await fs.mkdtemp(
		path.join(process.cwd(), ".wincode-versioned-smoke-")
	);
	const databasePath = path.join(root, "sessions.sqlite");
	const firstPath = path.join(root, "first.txt");
	const secondPath = path.join(root, "second.txt");
	let activeDatabase: OpenedSessionStore["database"] | undefined;
	try {
		await Bun.write(firstPath, "one\n");
		await Bun.write(secondPath, "two\n");
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		let store = opened.store;
		const { id: sessionId } = await store.createSession({
			agent: agentId("build"),
			message: {
				id: sessionMessageId("smoke-user"),
				parts: [{ text: "edit both files", type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId("smoke-turn"),
		});
		const context = (
			editMode: VersionedEditingContext["editMode"] = "hashline"
		) => ({
			editMode,
			sessionId,
			store: observationStoreFor(store),
		});
		const standardLimits = getToolResourceLimits();
		const artifactLimits = {
			...standardLimits,
			edit: {
				...standardLimits.edit,
				maxDiffBytes: 1,
				maxDiffLines: 1,
				maxFullDiffArtifactBytes: 10_000,
			},
		};
		const tools = await createTools(context("apply_patch"), artifactLimits);
		const firstRead = await tools.find("read").execute(
			{
				input: { path: firstPath },
				toolCallId: toolCallId("smoke-read-first"),
			},
			{}
		);
		const secondRead = await tools.find("read").execute(
			{
				input: { path: secondPath },
				toolCallId: toolCallId("smoke-read-second"),
			},
			{}
		);
		if (firstRead.type !== "success" || secondRead.type !== "success") {
			throw new Error("Smoke reads failed.");
		}
		const firstReadOutput = firstRead.output as { fileVersion: FileVersion };
		const firstVersion = firstReadOutput.fileVersion;
		const secondReadOutput = secondRead.output as { fileVersion: FileVersion };
		const secondVersion = secondReadOutput.fileVersion;
		const multiEdit = await tools.find("edit").execute(
			{
				input: {
					mode: "apply_patch",
					patch: [
						`[${firstPath}#${firstVersion}]`,
						"PUT 1.=1:",
						"+ONE",
						`[${secondPath}#${secondVersion}]`,
						"PUT 1.=1:",
						"+TWO",
					].join("\n"),
				},
				toolCallId: toolCallId("smoke-multi-edit"),
			},
			{}
		);
		if (multiEdit.type !== "success") {
			throw new Error(multiEdit.errorText);
		}
		const multiOutput = multiEdit.output as {
			files?: readonly [{ fullDiffArtifact?: { id: string } }, ...unknown[]];
		};
		const artifactId = multiOutput.files?.[0]?.fullDiffArtifact?.id;
		expect(artifactId).toBeString();
		const artifactRead = await tools.find("read").execute(
			{
				input: { path: `artifact://${artifactId}:1-` },
				toolCallId: toolCallId("smoke-read-artifact"),
			},
			{}
		);
		expect(artifactRead.type).toBe("success");
		expect(await Bun.file(firstPath).text()).toBe("ONE\n");
		expect(await Bun.file(secondPath).text()).toBe("TWO\n");

		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		store = reopened.store;
		const recovery = observationStoreFor(store).recovery;
		if (recovery === undefined) {
			throw new Error("Smoke store has no recovery support.");
		}
		const originalBytes = new TextEncoder().encode("ONE\n");
		const crashBytes = new TextEncoder().encode("CRASHED\n");
		await recovery.beginTransaction({
			originSessionId: sessionId,
			paths: [
				{
					canonicalPath: firstPath,
					displayPath: firstPath,
					newFileVersion: computeFileVersion(crashBytes),
					originalBytes,
					originalFileVersion: computeFileVersion(originalBytes),
				},
			],
		});
		await Bun.write(firstPath, crashBytes);
		activeDatabase.sqlite.close();
		activeDatabase = undefined;

		const restarted = openStore(root, databasePath);
		activeDatabase = restarted.database;
		store = restarted.store;
		const unresolved =
			await observationStoreFor(store).recovery?.listUnresolvedRecoveries();
		const recoveryId = unresolved?.[0]?.id;
		expect(recoveryId).toBeString();
		const restartedTools = await createTools(context());
		const inspection = await restartedTools.find("recover").execute(
			{
				input: { action: "inspect", recoveryId },
				toolCallId: toolCallId("smoke-inspect-recovery"),
			},
			{}
		);
		expect(inspection.type).toBe("success");
		const restored = await restartedTools.find("recover").execute(
			{
				input: {
					action: "restore-original",
					expectedVersions: {
						[firstPath]: computeFileVersion(crashBytes),
					},
					recoveryId,
				},
				toolCallId: toolCallId("smoke-restore-recovery"),
			},
			{}
		);
		if (restored.type !== "success") {
			throw new Error(restored.errorText);
		}
		expect(await Bun.file(firstPath).text()).toBe("ONE\n");

		const finalRead = await restartedTools.find("read").execute(
			{
				input: {
					expectedVersion: computeFileVersion(originalBytes),
					path: firstPath,
				},
				toolCallId: toolCallId("smoke-read-final"),
			},
			{}
		);
		if (finalRead.type !== "success") {
			throw new Error(finalRead.errorText);
		}
		const finalReadOutput = finalRead.output as { fileVersion: FileVersion };
		const finalVersion = finalReadOutput.fileVersion;
		const finalEdit = await restartedTools.find("edit").execute(
			{
				input: {
					patch: `[${firstPath}#${finalVersion}]\nPUT 1.=1:\n+FINAL`,
				},
				toolCallId: toolCallId("smoke-final-edit"),
			},
			{}
		);
		if (finalEdit.type !== "success") {
			throw new Error(finalEdit.errorText);
		}
		expect(await Bun.file(firstPath).text()).toBe("FINAL\n");
	} finally {
		activeDatabase?.sqlite.close();
		await fs.rm(root, { force: true, recursive: true });
	}
});

const advancingClock = (): FileObservationClock => {
	let now = 0;
	return {
		delay: async (milliseconds) => {
			now += milliseconds;
		},
		now: () => now,
		onInterval: () => () => undefined,
	};
};

const leasesOf = (
	store: FileObservationStore
): NonNullable<FileObservationStore["withPathLeases"]> => {
	const { withPathLeases } = store;
	if (withPathLeases === undefined) {
		throw new Error("The file observation store must support path leases.");
	}
	return withPathLeases;
};

test("a conflicting edit lease times out instead of waiting forever", async () => {
	const root = await fs.mkdtemp(
		path.join(process.cwd(), ".wincode-lease-timeout-")
	);
	const databasePath = path.join(root, "sessions.sqlite");
	const snapshotRoot = path.join(root, "snapshots");
	const filePath = path.join(root, "note.txt");
	const holderDatabase = createDatabase(databasePath);
	const contenderDatabase = createDatabase(databasePath);
	try {
		const holder = createDrizzleFileObservationStore(
			holderDatabase.db,
			snapshotRoot
		);
		const contender = createDrizzleFileObservationStore(
			contenderDatabase.db,
			snapshotRoot,
			undefined,
			advancingClock()
		);
		const holderStarted = Promise.withResolvers<void>();
		const releaseHolder = Promise.withResolvers<void>();
		const held = leasesOf(holder)([filePath], async () => {
			holderStarted.resolve();
			await releaseHolder.promise;
		});
		await holderStarted.promise;

		const error = await leasesOf(contender)(
			[filePath],
			async () => undefined
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CodingToolError);
		expect(error).toMatchObject({
			code: "path-lease-timeout",
			recovery: { action: "reread", path: filePath },
		});

		releaseHolder.resolve();
		await held;
	} finally {
		holderDatabase.sqlite.close();
		contenderDatabase.sqlite.close();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a lease that cannot be renewed is reported before the operation mutates", async () => {
	const root = await fs.mkdtemp(
		path.join(process.cwd(), ".wincode-lease-loss-")
	);
	const database = createDatabase(path.join(root, "sessions.sqlite"));
	const filePath = path.join(root, "note.txt");
	let heartbeat: (() => void) | undefined;
	const clock: FileObservationClock = {
		delay: async () => undefined,
		now: () => 1_700_000_000_000,
		onInterval: (callback) => {
			heartbeat = callback;
			return () => {
				heartbeat = undefined;
			};
		},
	};
	try {
		const store = createDrizzleFileObservationStore(
			database.db,
			path.join(root, "snapshots"),
			undefined,
			clock
		);

		const error = await leasesOf(store)([filePath], async (assertLease) => {
			database.db
				.delete(fileLease)
				.where(eq(fileLease.canonicalPath, filePath))
				.run();
			heartbeat?.();
			assertLease();
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CodingToolError);
		expect(error).toMatchObject({
			code: "path-lease-lost",
			recovery: { action: "reread", path: filePath },
		});
	} finally {
		database.sqlite.close();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("prunes an unreferenced snapshot only after the prune grace window", async () => {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".wincode-prune-"));
	const database = createDatabase(path.join(root, "sessions.sqlite"));
	const snapshotRoot = path.join(root, "snapshots");
	let now = 1_700_000_000_000;
	const clock: FileObservationClock = {
		delay: async () => undefined,
		now: () => now,
		onInterval: () => () => undefined,
	};
	try {
		const store = createDrizzleFileObservationStore(
			database.db,
			snapshotRoot,
			undefined,
			clock
		);
		const bytes = new TextEncoder().encode("prunable\n");
		const snapshot: FileSnapshot = {
			algorithm: FILE_VERSION_ALGORITHM,
			bytes,
			createdAt: now,
			fileVersion: computeFileVersion(bytes),
			lineCount: 1,
			path: path.join(root, "note.txt"),
		};
		const { getSnapshot, pruneSnapshots } = store;
		if (getSnapshot === undefined || pruneSnapshots === undefined) {
			throw new Error("The store must support snapshot pruning.");
		}
		await store.saveSnapshot(snapshot);

		now += 29_999;
		await pruneSnapshots();
		expect(
			await getSnapshot(snapshot.path, snapshot.fileVersion)
		).not.toBeNull();

		now += 1;
		await pruneSnapshots();
		expect(await getSnapshot(snapshot.path, snapshot.fileVersion)).toBeNull();
	} finally {
		database.sqlite.close();
		await fs.rm(root, { force: true, recursive: true });
	}
});
