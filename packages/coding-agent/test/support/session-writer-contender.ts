import {
	type AgentId,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
} from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "../../modules/providers/provider-model-selection";
import { createDatabase } from "../../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../modules/sessions/storage/drizzle-session-store";
import { resolveLocalSessionLogRoot } from "../../modules/sessions/storage/path";
import { createSessionJsonlStore } from "../../modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "../../modules/sessions/storage/session-record";
import { toSessionId } from "../../shared/identifiers";

const payload = JSON.parse(process.argv[2] ?? "") as Readonly<{
	attachmentRoot: string;
	databasePath: string;
	sessionId: string;
	snapshotRoot: string;
	workspaceRoot: string;
}>;
const connection = createDatabase(payload.databasePath);
const store = createDrizzleSessionStore(connection.db, {
	attachmentRoot: payload.attachmentRoot,
	snapshotRoot: payload.snapshotRoot,
	workspaceRoot: payload.workspaceRoot,
});
const sessionId = toSessionId(payload.sessionId);
const storage = createSessionJsonlStore(
	store,
	resolveLocalSessionLogRoot(payload.databasePath)
);
const report = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};
const createLineReader = (): (() => Promise<string>) => {
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async () => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				return line;
			}
			const { done, value } = await reader.read();
			if (done) {
				return "";
			}
			buffer += decoder.decode(value, { stream: true });
		}
	};
};
const readErrorCode = (error: unknown): string =>
	typeof error === "object" &&
	error !== null &&
	typeof Reflect.get(error, "code") === "string"
		? (Reflect.get(error, "code") as string)
		: "unknown";

try {
	const writer = await storage.acquireSessionWriter(sessionId, {
		executionMode: "interactive",
	});
	report({ kind: "acquired" });
	const nextLine = createLineReader();
	for (;;) {
		const line = await nextLine();
		const command = line.trim();
		if (command === "") {
			continue;
		}
		if (command === "release" || command === "exit") {
			break;
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
	await writer.release();
} catch (error) {
	report({ code: readErrorCode(error), kind: "rejected" });
} finally {
	connection.sqlite.close();
}
