import type { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	computeFileVersion,
	type FileObservationStore,
	getToolResourceLimits,
	runCodingTool,
	runRecoverTool,
	type VersionedEditingContext,
} from "@wincode/coding-tools";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

type OpenedStore = {
	database: { sqlite: SqliteDatabase };
	store: SessionStore;
};

const model = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
} as const;

const openStore = (root: string, databasePath: string): OpenedStore => {
	const database = createDatabase(databasePath);
	const store = createDrizzleSessionStore(database.db, {
		attachmentRoot: join(root, "attachments"),
		snapshotRoot: join(root, "snapshots"),
		workspaceRoot: root,
	});
	return { database, store };
};

const observationStoreFor = (store: SessionStore): FileObservationStore => {
	if (store.fileObservationStore === undefined) {
		throw new Error("The session store has no file observation store.");
	}
	return store.fileObservationStore;
};

const createSession = async (store: SessionStore) =>
	await store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("recovery-user"),
			parts: [{ text: "recover the file", type: "text" }],
			role: "user",
		},
		model,
		turnId: agentTurnId("recovery-turn"),
	});

test("restarts expose prepared transactions and reconcile with expected versions", async () => {
	const root = await mkdtemp(join(process.cwd(), ".wincode-recovery-"));
	const databasePath = join(root, "sessions.sqlite");
	const filePath = join(root, "note.txt");
	let activeDatabase: OpenedStore["database"] | undefined;
	try {
		const originalBytes = new TextEncoder().encode("original\n");
		const changedBytes = new TextEncoder().encode("changed\n");
		await writeFile(filePath, originalBytes);
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		const { id: sessionId } = await createSession(opened.store);
		const observationStore = observationStoreFor(opened.store);
		const transaction = await observationStore.recovery?.beginTransaction({
			originSessionId: sessionId,
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
		if (transaction === undefined) {
			throw new Error("The session store has no recovery store.");
		}
		await writeFile(filePath, changedBytes);
		activeDatabase.sqlite.close();
		activeDatabase = undefined;

		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		const restartedObservationStore = observationStoreFor(reopened.store);
		const unresolved =
			await restartedObservationStore.recovery?.listUnresolvedRecoveries();
		expect(unresolved).toHaveLength(1);
		const recoveryId = unresolved?.[0]?.id;
		if (recoveryId === undefined) {
			throw new Error("Restart did not register recovery.");
		}
		const inspection =
			await restartedObservationStore.recovery?.getRecoveryInspection(
				recoveryId
			);
		expect(inspection?.artifact.pinned).toBe(true);
		expect(inspection?.artifact.paths[0]?.originalBytes).toEqual(originalBytes);
		expect(inspection?.artifact.paths[0]?.currentFileVersion).toBe(
			computeFileVersion(changedBytes)
		);

		const context: VersionedEditingContext = {
			editMode: "hashline",
			sessionId,
			store: restartedObservationStore,
		};
		const inspected = await runRecoverTool(
			{ action: "inspect", recoveryId },
			{ versionedEditing: context }
		);
		expect(inspected.status).toBe("inspected");
		expect(await readFile(filePath, "utf8")).toBe("changed\n");
		const aliasPath = join(root, "note-alias.txt");
		await symlink(filePath, aliasPath);
		await expect(
			runCodingTool(
				"write",
				{
					content: "blocked alias\n",
					expectedVersion: computeFileVersion(changedBytes),
					path: aliasPath,
				},
				{
					allowExternalPath: true,
					resourceLimits: getToolResourceLimits(),
					versionedEditing: context,
				}
			)
		).rejects.toMatchObject({ code: "unresolved-recovery" });
		await expect(
			runCodingTool(
				"write",
				{
					content: "blocked\n",
					expectedVersion: computeFileVersion(changedBytes),
					path: filePath,
				},
				{
					allowExternalPath: true,
					resourceLimits: getToolResourceLimits(),
					versionedEditing: context,
				}
			)
		).rejects.toMatchObject({ code: "unresolved-recovery" });
		await expect(reopened.store.deleteSession(sessionId)).rejects.toMatchObject(
			{
				code: "session-recovery-required",
				details: {
					actions: ["resolve", "export", "discard", "cancel"],
				},
			}
		);

		await writeFile(filePath, originalBytes);
		const currentVersion = computeFileVersion(originalBytes);
		const restored = await runRecoverTool(
			{
				action: "restore-original",
				expectedVersions: { [filePath]: currentVersion },
				recoveryId,
			},
			{ resourceLimits: getToolResourceLimits(), versionedEditing: context }
		);
		expect(restored.status).toBe("resolved");
		expect(await readFile(filePath, "utf8")).toBe("original\n");
		expect(
			await restartedObservationStore.recovery?.listUnresolvedRecoveries()
		).toHaveLength(0);
	} finally {
		activeDatabase?.sqlite.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("restore-original removes files that did not exist before the transaction", async () => {
	const root = await mkdtemp(join(process.cwd(), ".wincode-recovery-create-"));
	const databasePath = join(root, "sessions.sqlite");
	const filePath = join(root, "created.txt");
	let activeDatabase: OpenedStore["database"] | undefined;
	try {
		const changedBytes = new TextEncoder().encode("created\n");
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		const { id: sessionId } = await createSession(opened.store);
		const recovery = observationStoreFor(opened.store).recovery;
		if (recovery === undefined) {
			throw new Error("The session store has no recovery store.");
		}
		await recovery.beginTransaction({
			originSessionId: sessionId,
			paths: [
				{
					canonicalPath: filePath,
					displayPath: filePath,
					newFileVersion: computeFileVersion(changedBytes),
					originalBytes: null,
					originalFileVersion: null,
				},
			],
		});
		await writeFile(filePath, changedBytes);
		const currentVersion = computeFileVersion(changedBytes);
		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		const restartedStore = observationStoreFor(reopened.store);
		const restartedUnresolved =
			await restartedStore.recovery?.listUnresolvedRecoveries();
		const restartedRecoveryId = restartedUnresolved?.[0]?.id;
		if (restartedRecoveryId === undefined) {
			throw new Error("Restart did not register recovery.");
		}
		const restored = await runRecoverTool(
			{
				action: "restore-original",
				expectedVersions: { [filePath]: currentVersion },
				recoveryId: restartedRecoveryId,
			},
			{
				resourceLimits: getToolResourceLimits(),
				versionedEditing: {
					editMode: "hashline",
					sessionId,
					store: restartedStore,
				},
			}
		);
		expect(restored.status).toBe("resolved");
		await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		activeDatabase?.sqlite.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("missing pinned bytes stay critical until an explicit discard", async () => {
	const root = await mkdtemp(
		join(process.cwd(), ".wincode-recovery-critical-")
	);
	const databasePath = join(root, "sessions.sqlite");
	const filePath = join(root, "note.txt");
	let activeDatabase: OpenedStore["database"] | undefined;
	try {
		const originalBytes = new TextEncoder().encode("original\n");
		const changedBytes = new TextEncoder().encode("changed\n");
		await writeFile(filePath, changedBytes);
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		const { id: sessionId } = await createSession(opened.store);
		const recovery = observationStoreFor(opened.store).recovery;
		if (recovery === undefined) {
			throw new Error("The session store has no recovery store.");
		}
		const transaction = await recovery.beginTransaction({
			originSessionId: sessionId,
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
		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		await rm(
			join(root, "snapshots", "recovery", "v1", transaction.id, "0.original")
		);

		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		const restartedStore = observationStoreFor(reopened.store);
		const unresolved =
			await restartedStore.recovery?.listUnresolvedRecoveries();
		expect(unresolved?.[0]?.status).toBe("critical");
		const recoveryId = unresolved?.[0]?.id;
		if (recoveryId === undefined) {
			throw new Error("Missing critical recovery record.");
		}
		const context: VersionedEditingContext = {
			editMode: "hashline",
			sessionId: "other-session",
			store: restartedStore,
		};
		await expect(
			runRecoverTool(
				{ action: "inspect", recoveryId },
				{ versionedEditing: context }
			)
		).rejects.toMatchObject({ code: "recovery-cross-session-permission" });
		await expect(
			runRecoverTool(
				{
					action: "keep-current",
					expectedVersions: {
						[filePath]: computeFileVersion(changedBytes),
					},
					recoveryId,
				},
				{ allowCrossSession: true, versionedEditing: context }
			)
		).rejects.toMatchObject({ code: "recovery-data-missing" });

		const originContext: VersionedEditingContext = {
			...context,
			sessionId,
		};
		const discarded = await runRecoverTool(
			{ action: "discard", confirm: true, recoveryId },
			{ versionedEditing: originContext }
		);
		expect(discarded.status).toBe("discarded");
		expect(
			await restartedStore.recovery?.listUnresolvedRecoveries()
		).toHaveLength(0);
	} finally {
		activeDatabase?.sqlite.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("recovery inspects and discards current binary bytes by raw File Version", async () => {
	const root = await mkdtemp(join(process.cwd(), ".wincode-recovery-binary-"));
	const databasePath = join(root, "sessions.sqlite");
	const filePath = join(root, "binary.dat");
	let activeDatabase: OpenedStore["database"] | undefined;
	try {
		const originalBytes = new TextEncoder().encode("original\n");
		const changedBytes = new Uint8Array([0, 255, 1, 2]);
		await writeFile(filePath, changedBytes);
		const opened = openStore(root, databasePath);
		activeDatabase = opened.database;
		const { id: sessionId } = await createSession(opened.store);
		const recovery = observationStoreFor(opened.store).recovery;
		if (recovery === undefined) {
			throw new Error("The session store has no recovery store.");
		}
		await recovery.beginTransaction({
			originSessionId: sessionId,
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
		activeDatabase.sqlite.close();
		activeDatabase = undefined;
		const reopened = openStore(root, databasePath);
		activeDatabase = reopened.database;
		const restartedStore = observationStoreFor(reopened.store);
		const unresolved =
			await restartedStore.recovery?.listUnresolvedRecoveries();
		const recoveryId = unresolved?.[0]?.id;
		if (recoveryId === undefined) {
			throw new Error("Restart did not register recovery.");
		}
		const context: VersionedEditingContext = {
			editMode: "hashline",
			sessionId,
			store: restartedStore,
		};
		const inspected = await runRecoverTool(
			{ action: "inspect", recoveryId },
			{ versionedEditing: context }
		);
		expect(inspected.paths[0]?.currentFileVersion).toBe(
			computeFileVersion(changedBytes)
		);
		const discarded = await runRecoverTool(
			{ action: "discard", confirm: true, recoveryId },
			{ versionedEditing: context }
		);
		expect(discarded.status).toBe("discarded");
		expect(new Uint8Array(await readFile(filePath))).toEqual(changedBytes);
	} finally {
		activeDatabase?.sqlite.close();
		await rm(root, { force: true, recursive: true });
	}
});
