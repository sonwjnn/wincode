import { useMemo } from "react";
import { useAgentRegistry } from "@/modules/agents/agent-registry-provider";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	createInteractiveSessionProviderCollection,
	pluginProvidersFromRuntime,
} from "@/modules/sessions/provider-collection";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import {
	getInteractivePluginRuntime,
	getInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { getSessionStore } from "../storage/get-session-store";
import { getInteractiveSessionHostManager } from "./session-host-manager";
import { openSessionServices, type SessionServices } from "./session-services";

/**
 * The Plugin runtime Interactive Mode's Sessions borrow until the process
 * supplies one. It holds no Plugins and is never closed, exactly like the
 * process runtime it stands in for: a Session Host outlives the view that
 * opened its Session Services, so they must not own a runtime a Host
 * still references.
 */
let standInPluginRuntime: PluginRuntime | undefined;
const interactiveStandInRuntime = (): PluginRuntime =>
	(standInPluginRuntime ??= createPluginRuntime([], []));

/** The handle that opens Session Services for a mount, and closes what it opened. */
export type SessionServicesHandle = Readonly<{
	/** Closes the opened Session Services, so a later `open` composes fresh ones. */
	close: () => Promise<void>;
	open: () => Promise<SessionServices>;
}>;

/**
 * Interactive Mode's adapter over the Session Services: it reads the TUI's
 * providers and passes them as sources, and the factory composes the graph
 * once for the mount.
 *
 * The returned handle opens lazily because opening is asynchronous, and every source
 * is a getter because a Session outlives the render that supplied it: a
 * reconnected Provider, a reloaded configuration, a replaced Plugin runtime, or
 * updated Provider Model metadata is what the Session's next work sees.
 * These services borrow everything they run on — the store, the Session Host
 * Manager, and the Plugin runtime, which is the process runtime or, before that
 * exists, a process-scoped stand-in — so closing them never stops Plugins a
 * Session Host still uses.
 */
export const useSessionServicesHandle = (): SessionServicesHandle => {
	const config = useConfig();
	const registry = useAgentRegistry();
	const configRef = useLatest(config);
	const registryRef = useLatest(registry);

	const composition = useMemo(() => createApplicationPluginComposition(), []);
	return useMemo(() => {
		const sessionHostManager = getInteractiveSessionHostManager();
		const initialPluginRuntime = getInteractivePluginRuntime();
		let opened: Promise<SessionServices> | undefined;
		return {
			close: async () => {
				const pending = opened;
				opened = undefined;
				const services = await pending?.catch(() => undefined);
				await services?.shutdown().catch(() => undefined);
			},
			open: () => {
				// A failed open is not remembered, so the surface's retry can try
				// again instead of awaiting the same rejection forever.
				opened ??= openSessionServices({
					policy: {
						cwd: configRef.current.cwd ?? configRef.current.workspace,
						workspace: configRef.current.workspace,
					},
					sources: {
						configRuntime: () => configRef.current,
						registry: () => registryRef.current,
						sessionHostManager: () => sessionHostManager,
						store: () => getSessionStore(),
						createProviderCollection: (
							pluginRuntime,
							sessionId,
							allowedPluginProviderIds,
							allowedPluginProviderSources
						) => {
							const createProviderCollection =
								getInteractiveRuntimeContext().createProviderCollection;
							if (createProviderCollection !== undefined) {
								return createProviderCollection(
									pluginRuntime,
									sessionId,
									allowedPluginProviderIds,
									allowedPluginProviderSources
								);
							}
							return createInteractiveSessionProviderCollection({
								sessionId,
								pluginProviders: pluginProvidersFromRuntime(
									pluginRuntime,
									sessionId,
									allowedPluginProviderIds,
									allowedPluginProviderSources
								),
							});
						},
						turnToolResolver: () => composition.turnToolResolver,
						pluginRuntime: () =>
							getInteractiveRuntimeContext().pluginRuntime ??
							initialPluginRuntime ??
							interactiveStandInRuntime(),
					},
				}).catch((error: unknown) => {
					opened = undefined;
					throw error;
				});
				return opened;
			},
		};
	}, [composition]);
};
