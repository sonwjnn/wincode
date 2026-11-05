import * as path from "node:path";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "../../modules/providers/provider-model-selection";
import { createSessionSdkWithRuntime } from "../../modules/sessions/sdk";
import {
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "../../modules/sessions/storage/attachment-store";
import { createDatabase } from "../../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../../modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "../../modules/sessions/storage/path";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "../../modules/sessions/storage/session-jsonl-store";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "./e2e-fake-runtime";

const databasePath = process.env.TEST_DATABASE_PATH;
const workspace = process.env.TEST_WORKSPACE;
if (databasePath === undefined || workspace === undefined) {
	throw new Error("Session crash test paths were not provided.");
}

const blocked = Promise.withResolvers<void>();
const deliveryText = "Persist this before the process exits.";
let blockNextSessionLogSync = false;
const fileIo: SessionLogFileIo = {
	sync: async (filePath, handle) => {
		await handle.sync();
		if (
			blockNextSessionLogSync &&
			path.extname(filePath) === ".jsonl" &&
			(await Bun.file(filePath).text()).includes(deliveryText)
		) {
			blockNextSessionLogSync = false;
			process.stdout.write(`${JSON.stringify({ kind: "log-synced" })}\n`);
			await blocked.promise;
		}
	},
};

const operational = createDatabase(databasePath);
const projection = createDatabase(
	resolveLocalSessionProjectionPath(databasePath)
);
const attachmentRoot = path.join(path.dirname(databasePath), "attachments");
const logRoot = resolveLocalSessionLogRoot(databasePath);
const attachmentStore = createSessionAttachmentStore({
	lifecycleRoot: logRoot,
	repository: createDrizzleAttachmentMetadataRepository(projection.db),
	root: attachmentRoot,
});
const projectionStore = createDrizzleSessionStore(projection.db, {
	attachmentRoot,
	attachmentStore,
	operationalDatabase: operational.db,
	sessionLogRoot: logRoot,
	workspaceRoot: workspace,
});
const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);
const recorder = createFakeProviderRecorder();
const sdk = await createSessionSdkWithRuntime({
	createProviderCollection: () => createFakeProviderCollection(recorder),
	cwd: workspace,
	databasePath,
	pluginPaths: [],
	store,
	workspace,
});
const sessionId = await sdk.createEmptySession({
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
});
process.stdout.write(`${JSON.stringify({ kind: "session", sessionId })}\n`);
const handle = await sdk.openSession(sessionId, { autoContinue: false });
blockNextSessionLogSync = true;
const delivery = handle.deliver({
	idempotencyKey: "crash-before-ack",
	text: deliveryText,
});
void delivery.then(
	() => process.stdout.write(`${JSON.stringify({ kind: "delivery-ack" })}\n`),
	() =>
		process.stdout.write(`${JSON.stringify({ kind: "delivery-rejected" })}\n`)
);
void Bun.sleep(10_000).then(() =>
	process.stdout.write(`${JSON.stringify({ kind: "watchdog" })}\n`)
);
await blocked.promise;
