import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { PluginSessionState } from "../../../modules/sessions/storage/plugin-session-state";
import { successfulSessionWriteOutcome } from "./outcome";

/** A Plugin Session State stub over projection-only storage. */
export const pluginSessionStateFacet = (
	_projectionStore: DrizzleSessionStore
): PluginSessionState => ({
	getPluginSessionState: async () => undefined,
	mutatePluginSessionState: async (_sessionId, _pluginId, mutation) => ({
		kind: "written",
		writeOutcome: successfulSessionWriteOutcome(mutation.operationId),
	}),
});
