import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionLifecycle } from "../../../modules/sessions/storage/session-lifecycle";
import { successfulSessionWriteOutcome } from "./outcome";

/**
 * A Session Lifecycle stub over projection-only storage for tests that exercise
 * one lifecycle behavior and cannot run the authoritative JSONL store.
 */
export const lifecycleFacet = (
	projectionStore: DrizzleSessionStore
): SessionLifecycle => ({
	acquireSessionWriter: async (sessionId, options) =>
		await projectionStore.acquireSessionWriter(sessionId, options),
	completeSessionForkAction: async () => {
		throw new Error(
			"Session fork action IDs are not used by this projection-only test store."
		);
	},
	confirmSessionImportActivation: async () => undefined,
	createEmptySession: async (input) => {
		const created = await projectionStore.createEmptySession(input);
		return {
			...created,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	createSession: async (input) => {
		const created = await projectionStore.createSession(input);
		return {
			...created,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	createSessionWithExternalizedMessage: async (input) => {
		const created = await projectionStore.createSession(input);
		return {
			...created,
			message: input.message,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	deleteSession: async (sessionId) => {
		await projectionStore.deleteSession(sessionId);
		return successfulSessionWriteOutcome(`delete-${sessionId}`);
	},
	forkSession: async () => {
		throw new Error(
			"Session forking is not used by this projection-only test store."
		);
	},
	forkSessionWithHeldWriter: async () => {
		throw new Error(
			"Session forking is not used by this projection-only test store."
		);
	},
	getEditMode: async (sessionId) =>
		(await projectionStore.getEditMode?.(sessionId)) ?? "hashline",
	getOrCreateSessionForkActionId: async () => {
		throw new Error(
			"Session fork action IDs are not used by this projection-only test store."
		);
	},
	getSessionForkProvenance: async () => undefined,
	isSessionImportActivationPending: async () => false,
	isSessionImported: async () => false,
	rebuildProjection: async (_scope, withMaintenanceGate) =>
		await withMaintenanceGate(async () => ({
			generation: 0,
			issues: [],
			rebuiltSessionIds: [],
			skippedSessionIds: [],
		})),
	resetSessionData: async () => {
		await projectionStore.resetSessionData();
	},
	setEditMode: async (sessionId, mode, operationId) => {
		await projectionStore.setEditMode?.(sessionId, mode, operationId);
		return successfulSessionWriteOutcome(operationId ?? crypto.randomUUID());
	},
	updateSession: async (sessionId, input) => {
		const operationId = input.operationId ?? crypto.randomUUID();
		await projectionStore.updateSession(sessionId, { ...input, operationId });
		return successfulSessionWriteOutcome(operationId);
	},
	withSessionBundleExport: async () => {
		throw new Error(
			"Session bundle export is not used by this projection-only test store."
		);
	},
	withSessionBundleImport: async () => {
		throw new Error(
			"Session bundle import is not used by this projection-only test store."
		);
	},
});
