import { createDatabase } from "../../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../modules/sessions/storage/drizzle-session-store";
import { toSessionId } from "../../shared/identifiers";

const bunGlobal = globalThis as typeof globalThis & {
	Bun: { stdin: { stream: () => ReadableStream<Uint8Array> } };
};

type AcquireMessage = Readonly<{
	attachmentRoot: string;
	databasePath: string;
	now: number;
	sessionId: string;
	snapshotRoot: string;
	workspaceRoot: string;
}>;

const payload = JSON.parse(process.argv[2] ?? "") as AcquireMessage;
const connection = createDatabase(payload.databasePath);
const store = createDrizzleSessionStore(connection.db, {
	attachmentRoot: payload.attachmentRoot,
	snapshotRoot: payload.snapshotRoot,
	workspaceRoot: payload.workspaceRoot,
});

try {
	const lease = await store.acquireSessionLease(
		toSessionId(payload.sessionId),
		{
			now: () => payload.now,
		}
	);
	process.stdout.write(`${JSON.stringify({ kind: "acquired" })}\n`);
	await new Response(bunGlobal.Bun.stdin.stream()).text();
	lease.release();
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
