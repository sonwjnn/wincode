import type { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type FileObservationStore,
	type FileVersion,
	getToolResourceLimits,
	type VersionedEditingContext,
} from "@wincode/coding-tools";
import { createWorkspaceSandbox } from "@wincode/coding-tools/workspace";
import {
	createPermissionService,
	createToolPermission,
} from "@/modules/permissions";
import { createGatedCodingTools } from "@/modules/sessions/hooks/runtime-turn";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	createToolGate,
	type ToolGateApprovalPort,
} from "@/modules/tool-gate/tool-gate";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

type OpenedSessionStore = {
	database: { sqlite: SqliteDatabase };
	store: SessionStore;
};

const model = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
} as const;

const createApprovalPort = (
	requests: ToolApprovalRequest[]
): ToolGateApprovalPort => ({
	request: async (request) => {
		requests.push(request);
		return { decision: "allow", remember: false };
	},
});

const openStore = (root: string, databasePath: string): OpenedSessionStore => {
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

const createTools = (
	root: string,
	context: VersionedEditingContext,
	requests: ToolApprovalRequest[]
) => {
	const gate = createToolGate({
		approvals: createApprovalPort(requests),
		resolvePermission: async () => createToolPermission(),
		resolveResourceLimits: async () => getToolResourceLimits(),
		sandbox: createWorkspaceSandbox(root),
		service: createPermissionService(),
	});
	const tools = createGatedCodingTools({
		agentTools: ["read", "write", "edit"],
		gate,
		versionedEditing: context,
	});
	return {
		find(name: "edit" | "read" | "write") {
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

test("persists observations across restart and gates sloppy edits separately", async () => {
	const root = await mkdtemp(
		join(process.cwd(), ".wincode-versioned-editing-")
	);
	const databasePath = join(root, "sessions.sqlite");
	const filePath = join(root, "note.txt");
	let activeDatabase: OpenedSessionStore["database"] | undefined;
	try {
		await writeFile(filePath, "one\ntwo\n");
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
		const requests: ToolApprovalRequest[] = [];
		const tools = createTools(root, context(), requests);
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
		const restartedRequests: ToolApprovalRequest[] = [];
		const restartedTools = createTools(
			root,
			restartedContext(),
			restartedRequests
		);
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
		expect(await readFile(filePath, "utf8")).toBe("ONE\ntwo\n");
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
		const sloppyRequests: ToolApprovalRequest[] = [];
		const sloppyTools = createTools(root, sloppyContext, sloppyRequests);
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
		expect(sloppyRequests.length).toBeGreaterThan(0);
		expect(await readFile(filePath, "utf8")).toBe("DONE\ntwo\n");

		const newFilePath = join(root, "nested", "created.txt");
		const writeResult = await sloppyTools.find("write").execute(
			{
				input: { content: "created\n", path: newFilePath },
				toolCallId: toolCallId("write-new"),
			},
			{}
		);
		if (writeResult.type !== "success") {
			throw new Error(writeResult.errorText);
		}
		expect(await readFile(newFilePath, "utf8")).toBe("created\n");
	} finally {
		activeDatabase?.sqlite.close();
		await rm(root, { force: true, recursive: true });
	}
});
