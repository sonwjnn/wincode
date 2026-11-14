import type { SessionId } from "@/shared/identifiers";
import type {
	PluginSessionStateMutation,
	PluginSessionStateMutationResult,
	PluginSessionStateRecord,
} from "../session-plugin-state";

/**
 * Durable state one Plugin owns inside one Session. It is keyed by Plugin and
 * key, never by transcript position, so it is state a Plugin keeps alongside a
 * Session rather than history of the conversation; the Session Host Manager is
 * its only consumer.
 */
export type PluginSessionState = Readonly<{
	getPluginSessionState: (
		sessionId: SessionId,
		pluginId: string,
		key: string
	) => Promise<PluginSessionStateRecord | undefined>;
	mutatePluginSessionState: (
		sessionId: SessionId,
		pluginId: string,
		mutation: PluginSessionStateMutation
	) => Promise<PluginSessionStateMutationResult>;
}>;
