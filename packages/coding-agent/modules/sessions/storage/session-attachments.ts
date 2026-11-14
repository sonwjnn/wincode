import type { AttachmentReference } from "../attachment-reference";
import type { SessionMessage } from "../message";
import type {
	AttachmentExternalizationLease,
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	AttachmentResolution,
	CompactionAttachmentMetadata,
} from "./attachment-store";

/**
 * The blob lifecycle behind one Session's messages: externalizing message
 * content into blobs, hydrating it back, keeping a queued composition's blobs
 * alive, releasing them, resolving a reference the wire sent, and reclaiming
 * what nothing names any more.
 *
 * Retention counts and is process-owned: the same blob held by two compositions
 * survives either release order, and a release of an unknown id is a no-op.
 */
export type SessionAttachments = Readonly<{
	/** Annotates stored messages for display without changing what the model is sent. */
	annotateMessagesForDisplay: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal
	) => Promise<SessionMessage[]>;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
	/** The attachment metadata a compaction summary carries forward. */
	getCompactionMetadata: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal
	) => Promise<CompactionAttachmentMetadata[]>;
	externalizeAttachments: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<AttachmentExternalizationLease>;
	hydrateAttachments: (
		messages: readonly SessionMessage[],
		options: AttachmentHydrationOptions
	) => Promise<SessionMessage[]>;
	/** Releases blobs a composition no longer holds; an unknown id is a no-op. */
	releaseAttachments: (attachmentIds: Iterable<string>) => Promise<void>;
	resolveAttachmentReference: (
		reference: AttachmentReference,
		signal?: AbortSignal
	) => Promise<AttachmentResolution>;
	/** Keeps blobs alive past the records that name them, so maintenance cannot reclaim them. */
	retainAttachments: (attachmentIds: Iterable<string>) => Promise<void>;
}>;
