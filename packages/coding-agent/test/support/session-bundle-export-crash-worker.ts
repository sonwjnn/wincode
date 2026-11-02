import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { createSessionBundleExportOperation } from "@/modules/sessions/session-bundle-export";
import {
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import { createSessionJsonlStore } from "@/modules/sessions/storage/session-jsonl-store";
import { toSessionId } from "@/shared/identifiers";

const root = process.argv[2];
if (root === undefined) {
	throw new Error("The crash worker requires its temporary root path.");
}

const workspace = path.join(root, "workspace");
const databasePath = path.join(root, "sessions.sqlite");
await fs.mkdir(workspace, { recursive: true });
const operational = createDatabase(databasePath);
const projection = createDatabase(
	resolveLocalSessionProjectionPath(databasePath)
);
const logRoot = resolveLocalSessionLogRoot(databasePath);
const attachmentRoot = path.join(root, "attachments");
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
const store = createSessionJsonlStore(projectionStore, logRoot);
const created = await store.createEmptySession({
	id: toSessionId("bundle-export-crash-source"),
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
});
if (created.writeOutcome.kind !== "committed") {
	throw new Error("The crash worker Session was not committed.");
}
const exportSession = createSessionBundleExportOperation(
	createSessionHostManager(),
	store,
	{
		beforePublish: async () => {
			// Terminate without running staging cleanup, as an OS process crash would.
			process.exit(73);
		},
	}
);
await exportSession({
	destination: path.join(root, "crash-bundle"),
	sessionId: created.id,
});
throw new Error("The crash hook did not terminate the worker.");
