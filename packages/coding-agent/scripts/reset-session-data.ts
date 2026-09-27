import {
	resolveLocalAttachmentRoot,
	resolveLocalDatabasePath,
	resolveLocalSnapshotRoot,
} from "../modules/sessions/storage/path";
import { resetLocalSessionData } from "../modules/sessions/storage/reset-local-session-data";

const databasePath = resolveLocalDatabasePath();
await resetLocalSessionData({
	attachmentRoot: resolveLocalAttachmentRoot(databasePath),
	databasePath,
	snapshotRoot: resolveLocalSnapshotRoot(databasePath),
});
