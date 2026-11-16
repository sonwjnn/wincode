import type { SessionAttachmentStore } from "../../modules/sessions/storage/attachment-store";
import type { SessionJsonlProjectionStore } from "../../modules/sessions/storage/drizzle-session-store";
import {
	createSessionJsonlStore,
	type SessionJsonlStoreTestObserver,
} from "../../modules/sessions/storage/session-jsonl-store";
import type { SessionLogFileIo } from "../../modules/sessions/storage/session-log";
import type { SessionStorage } from "../../modules/sessions/storage/session-storage";
import { createTestSessionAttachmentStore } from "./session-facets/attachments";

export const createTestSessionJsonlStore = (
	projectionStore: SessionJsonlProjectionStore,
	logRoot: string,
	fileIo: SessionLogFileIo = {},
	testObserver?: SessionJsonlStoreTestObserver,
	attachmentStore: SessionAttachmentStore = createTestSessionAttachmentStore(
		logRoot
	)
): SessionStorage =>
	createSessionJsonlStore(
		projectionStore,
		logRoot,
		attachmentStore,
		fileIo,
		testObserver
	);
