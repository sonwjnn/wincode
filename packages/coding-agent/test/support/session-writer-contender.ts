import { createDatabase } from "../../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../modules/sessions/storage/drizzle-session-store";
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

try {
	const writer = await store.acquireSessionWriter(
		toSessionId(payload.sessionId),
		{
			executionMode: "interactive",
		}
	);
	process.stdout.write(`${JSON.stringify({ kind: "acquired" })}\n`);
	await new Response(Bun.stdin.stream()).text();
	await writer.release();
} catch (error) {
	const code =
		typeof error === "object" &&
		error !== null &&
		typeof Reflect.get(error, "code") === "string"
			? Reflect.get(error, "code")
			: "unknown";
	process.stdout.write(`${JSON.stringify({ code, kind: "rejected" })}\n`);
} finally {
	connection.sqlite.close();
}
