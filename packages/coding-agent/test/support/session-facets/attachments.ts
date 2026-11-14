import type { SessionAttachmentStore } from "../../../modules/sessions/storage/attachment-store";
import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionAttachments } from "../../../modules/sessions/storage/session-attachments";

/** A Session Attachments stub over projection-only storage. */
export const attachmentsFacet = (
	projectionStore: DrizzleSessionStore
): SessionAttachments => ({
	annotateMessagesForDisplay: async (messages, signal) =>
		await projectionStore.attachmentStore.annotateMessagesForDisplay(
			messages,
			signal
		),
	collectAttachments: async (safetyWindowMs) =>
		await projectionStore.collectAttachments(safetyWindowMs),
	externalizeAttachments: async (messages, signal, options) =>
		await projectionStore.externalizeAttachments(messages, signal, options),
	getCompactionMetadata: async (messages, signal) =>
		await projectionStore.attachmentStore.getCompactionMetadata(
			messages,
			signal
		),
	hydrateAttachments: async (messages, options) =>
		await projectionStore.hydrateAttachments(messages, options),
	releaseAttachments: async (attachmentIds) => {
		await projectionStore.attachmentStore.release(attachmentIds);
	},
	resolveAttachmentReference: async (reference, signal) =>
		await projectionStore.attachmentStore.resolve(reference, signal),
	retainAttachments: async (attachmentIds) => {
		await projectionStore.attachmentStore.retain(attachmentIds);
	},
});

/** A Session Attachments facet over a raw attachment sub-store, for tests that build only that. */
export const attachmentsOver = (
	attachmentStore: SessionAttachmentStore
): SessionAttachments => ({
	annotateMessagesForDisplay: (messages, signal) =>
		attachmentStore.annotateMessagesForDisplay(messages, signal),
	collectAttachments: async (safetyWindowMs) =>
		await attachmentStore.collect({
			liveAttachmentIds: async () => [],
			...(safetyWindowMs === undefined ? {} : { safetyWindowMs }),
		}),
	externalizeAttachments: (messages, signal, options) =>
		attachmentStore.externalizeMessagesWithLease(messages, signal, options),
	getCompactionMetadata: (messages, signal) =>
		attachmentStore.getCompactionMetadata(messages, signal),
	hydrateAttachments: (messages, options) =>
		attachmentStore.hydrateMessages(messages, options),
	releaseAttachments: (attachmentIds) => attachmentStore.release(attachmentIds),
	resolveAttachmentReference: (reference, signal) =>
		attachmentStore.resolve(reference, signal),
	retainAttachments: (attachmentIds) => attachmentStore.retain(attachmentIds),
});
