import {
	type AgentId,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
} from "@wincode/agent-core";
import { codeOf } from "@wincode/utils";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "../../modules/providers/provider-model-selection";
import {
	createDrizzleAttachmentMetadataRepository,
	createDrizzlePromptHistoryAttachmentLivenessSource,
	createSessionAttachmentStore,
} from "../../modules/sessions/storage/attachment-store";
import { createDatabase } from "../../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../modules/sessions/storage/drizzle-session-store";
import { resolveLocalSessionLogRoot } from "../../modules/sessions/storage/path";
import { createSessionJsonlStore } from "../../modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "../../modules/sessions/storage/session-record";
import { toSessionId } from "../../shared/identifiers";
import { createLineReader } from "./peer-protocol";

const payload = JSON.parse(process.argv[2] ?? "") as Readonly<{
	attachmentRoot: string;
	databasePath: string;
	sessionId: string;
	snapshotRoot: string;
	workspaceRoot: string;
}>;
const connection = createDatabase(payload.databasePath);
const logRoot = resolveLocalSessionLogRoot(payload.databasePath);
const attachmentStore = createSessionAttachmentStore({
	additionalLiveAttachmentIds:
		createDrizzlePromptHistoryAttachmentLivenessSource(connection.db),
	lifecycleRoot: logRoot,
	repository: createDrizzleAttachmentMetadataRepository(connection.db),
	root: payload.attachmentRoot,
});
const store = createDrizzleSessionStore(connection.db, {
	attachmentStore,
	snapshotRoot: payload.snapshotRoot,
	workspaceRoot: payload.workspaceRoot,
});
const sessionId = toSessionId(payload.sessionId);
const storage = createSessionJsonlStore(store, logRoot, attachmentStore);
const report = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};
const readErrorCode = (error: unknown): string => codeOf(error) ?? "unknown";

try {
	const writer = await storage.acquireSessionWriter(sessionId, {
		executionMode: "interactive",
	});
	let writerReleased = false;
	const releaseWriter = async (): Promise<void> => {
		if (writerReleased) {
			return;
		}
		writerReleased = true;
		await writer.release();
	};
	report({ kind: "acquired" });
	const lines = createLineReader(Bun.stdin.stream());
	for (;;) {
		const line = await lines.next();
		const command = line.trim();
		if (command === "") {
			continue;
		}
		if (command === "release" || command === "exit") {
			break;
		}
		if (command === "tree-page") {
			try {
				const page = await storage.readSessionHistoryTreePage(sessionId, {
					limit: 1,
				});
				report({ kind: "tree-page-result", nextCursor: page.nextCursor });
			} catch (error) {
				report({ code: readErrorCode(error), kind: "read-error" });
			}
			continue;
		}
		if (command === "rebuild") {
			try {
				await releaseWriter();
				const result = await storage.rebuildProjection(
					{ kind: "session", sessionId },
					(operation) => operation()
				);
				report({ kind: "rebuild-result", issues: result.issues });
			} catch (error) {
				report({ code: readErrorCode(error), kind: "rebuild-error" });
			}
			continue;
		}
		if (command.startsWith("append ")) {
			const input = JSON.parse(command.slice("append ".length)) as Readonly<{
				operationId: string;
				title: string;
			}>;
			try {
				const outcome = await storage.updateSession(sessionId, {
					operationId: input.operationId,
					title: input.title,
				});
				report({ kind: "append-result", outcome });
			} catch (error) {
				report({ code: readErrorCode(error), kind: "append-error" });
			}
			continue;
		}
		if (command.startsWith("commit-record ")) {
			const input = JSON.parse(
				command.slice("commit-record ".length)
			) as Readonly<{ operationId: string; text: string; turnId: string }>;
			try {
				const record = {
					...buildUserSessionRecord({
						agentId: "build" as AgentId,
						message: {
							id: toSessionMessageId(`${input.operationId}-message`),
							parts: [{ text: input.text, type: "text" }],
							role: "user",
						},
						model: DEFAULT_PROVIDER_MODEL_SELECTION,
						turnId: toAgentTurnId(input.turnId),
					}),
					id: toSessionRecordId(`${input.operationId}-record`),
				};
				const outcome = await storage.commitSessionRecord({
					record,
					sessionId,
					sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				});
				report({ kind: "append-result", outcome });
			} catch (error) {
				report({ code: readErrorCode(error), kind: "append-error" });
			}
			continue;
		}
		if (command === "delete") {
			try {
				const outcome = await storage.deleteSession(sessionId);
				report({ kind: "delete-result", outcome });
			} catch (error) {
				report({ code: readErrorCode(error), kind: "delete-error" });
			}
			continue;
		}
		if (command === "read") {
			try {
				const session = await storage.getSession(sessionId);
				const records = await storage.listSessionRecords(sessionId);
				report({
					kind: "read-result",
					recordCount: records.length,
					title: session.title,
				});
			} catch (error) {
				report({ code: readErrorCode(error), kind: "read-error" });
			}
			continue;
		}
		report({ kind: "unknown-command" });
	}
	await releaseWriter();
} catch (error) {
	report({ code: readErrorCode(error), kind: "rejected" });
} finally {
	connection.sqlite.close();
}
