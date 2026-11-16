import * as path from "node:path";
import {
	createMemoryAttachmentMetadataRepository,
	createSessionAttachmentStore,
	type SessionAttachmentStore,
} from "../../../modules/sessions/storage/attachment-store";
import type { SessionAttachments } from "../../../modules/sessions/storage/session-attachments";

const attachmentStores = new Map<string, SessionAttachmentStore>();

export const createTestSessionAttachmentStore = (
	lifecycleRoot: string,
	root = path.join(path.dirname(lifecycleRoot), "attachments")
): SessionAttachmentStore => {
	const existing = attachmentStores.get(lifecycleRoot);
	if (existing !== undefined) {
		return existing;
	}
	const attachmentStore = createSessionAttachmentStore({
		lifecycleRoot,
		repository: createMemoryAttachmentMetadataRepository(),
		root,
	});
	attachmentStores.set(lifecycleRoot, attachmentStore);
	return attachmentStore;
};

export const attachmentsOver = (
	attachmentStore: SessionAttachmentStore
): SessionAttachments => ({
	annotateMessagesForDisplay: (messages, signal) =>
		attachmentStore.annotateMessagesForDisplay(messages, signal),
	collectAttachments: async (safetyWindowMs) =>
		await attachmentStore.collect({
			liveAttachmentIds: attachmentStore.readAdditionalLiveAttachmentIds,
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
