import type { SessionAttachmentStore } from "../../../modules/sessions/storage/attachment-store";
import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionStorage } from "../../../modules/sessions/storage/session-storage";
import { attachmentsOver } from "./attachments";
import { catalogFacet } from "./catalog";
import { historyFacet } from "./history";
import { lifecycleFacet } from "./lifecycle";
import { pluginSessionStateFacet } from "./plugin-session-state";
import { recordsFacet } from "./records";

/**
 * Composes every facet stub over projection-only storage, for the few unit tests
 * that open a real Session Host. A test that needs one facet takes that facet's
 * file directly instead.
 */
export const sessionStorageWithSuccessfulWrites = (
	projectionStore: DrizzleSessionStore,
	attachmentStore: SessionAttachmentStore
): SessionStorage => ({
	...recordsFacet(projectionStore),
	...catalogFacet(projectionStore),
	...historyFacet(projectionStore),
	...lifecycleFacet(projectionStore),
	...attachmentsOver(attachmentStore),
	...pluginSessionStateFacet(projectionStore),
});
