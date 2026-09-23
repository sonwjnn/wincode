import { useMemo } from "react";
import { useAgentRegistry } from "@/modules/agents/agent-registry-provider";
import { useConnections } from "@/modules/connections/context/connections-provider";
import { useMcp } from "@/modules/mcp/context/mcp-provider";
import { useToolPermission } from "@/modules/permissions/use-tool-permission";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import { createSessionCompaction } from "../compaction/compaction";
import { estimateCompactionTokens } from "../compaction/config";
import { createDirectSummaryGenerator } from "../compaction/summary-generator";
import { useCompactionSettings } from "../compaction/use-compaction-settings";
import { getSessionStore } from "../storage/get-session-store";
import type { SessionCapabilities } from "./types";

/**
 * Composes one session's capabilities from the TUI's providers. Every
 * capability is handed to the Session Host as a getter that reads the current
 * value, because the session outlives the render that supplied it: a
 * connection made, a config reloaded, or a registry refreshed after the
 * session opened is what its next turn runs with.
 *
 * The returned object is stable for the lifetime of the mounting component, so
 * a session is never reopened because a provider re-rendered.
 */
export const useSessionCapabilities = (): SessionCapabilities => {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const registry = useAgentRegistry();
	const toolPermission = useToolPermission();
	const { getCompactionSettings } = useCompactionSettings();
	const connectionsRef = useLatest(connections);
	const mcpRef = useLatest(mcp);
	const configRef = useLatest(config);
	const registryRef = useLatest(registry);
	const toolPermissionRef = useLatest(toolPermission);
	const getCompactionSettingsRef = useLatest(getCompactionSettings);
	const summaryGenerator = useMemo(
		() => createDirectSummaryGenerator(connections),
		[connections]
	);
	const compactionModule = useMemo(
		() =>
			createSessionCompaction({
				attachmentStore: getSessionStore().attachmentStore,
				estimateTokens: (messages) => estimateCompactionTokens(messages),
				store: getSessionStore(),
				summaryGenerator,
			}),
		[summaryGenerator]
	);
	const compactionModuleRef = useLatest(compactionModule);

	// The refs this object closes over are stable for the component's life, so
	// the capabilities object is composed once: a session is never reopened
	// because a provider re-rendered.
	return useMemo(
		() => ({
			getCompactionModule: () => compactionModuleRef.current,
			getCompactionSettings: (model) => getCompactionSettingsRef.current(model),
			getConfig: () => configRef.current,
			getConnections: () => connectionsRef.current,
			getMcp: () => mcpRef.current,
			getRegistry: () => registryRef.current,
			getStore: () => getSessionStore(),
			getToolPermission: () => toolPermissionRef.current,
		}),
		[]
	);
};
