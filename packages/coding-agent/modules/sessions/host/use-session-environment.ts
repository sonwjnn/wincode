import { useMemo } from "react";
import { useAgentRegistry } from "@/modules/agents/agent-registry-provider";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import { useConnections } from "@/modules/connections";
import { useModelPricing } from "@/modules/model-pricing";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import {
	getInteractivePluginRuntime,
	getInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { getSessionStore } from "../storage/get-session-store";
import {
	openSessionEnvironment,
	type SessionEnvironment,
} from "./session-environment";
import { getInteractiveSessionHostManager } from "./session-host-manager";

/**
 * The Plugin runtime Interactive Mode's Sessions borrow until the process
 * supplies one. It holds no Plugins and is never closed, exactly like the
 * process runtime it stands in for: a Session Host outlives the view that
 * opened its environment, so the environment must not own a runtime a Host
 * still references.
 */
let standInPluginRuntime: PluginRuntime | undefined;
const interactiveStandInRuntime = (): PluginRuntime =>
	(standInPluginRuntime ??= createPluginRuntime([], []));

/** Opens one Session Environment for a mount, and closes the one it opened. */
export type SessionEnvironmentOpener = Readonly<{
	/** Closes the opened environment, so a later `open` composes a fresh one. */
	close: () => Promise<void>;
	open: () => Promise<SessionEnvironment>;
}>;

/**
 * Interactive Mode's adapter over the Session Environment: it reads the TUI's
 * providers and passes them as sources, and the environment composes the graph
 * once for the mount.
 *
 * The returned opener is lazy because opening is asynchronous, and every source
 * is a getter because a Session outlives the render that supplied it: a
 * reconnected provider, a reloaded configuration, a replaced Plugin runtime, or
 * an arriving Model Catalog pricing table is what the Session's next work sees.
 * The environment borrows everything it runs on — the store, the Session Host
 * Manager, and the Plugin runtime, which is the process runtime or, before that
 * exists, a process-scoped stand-in — so closing it never stops Plugins a
 * Session Host still uses.
 */
export const useSessionEnvironmentOpener = (): SessionEnvironmentOpener => {
	const connections = useConnections();
	const config = useConfig();
	const registry = useAgentRegistry();
	const { table: pricing } = useModelPricing();
	const connectionsRef = useLatest(connections);
	const configRef = useLatest(config);
	const registryRef = useLatest(registry);
	const pricingRef = useLatest(pricing);

	const runtimeContext = getInteractiveRuntimeContext();
	const runtimeFactory = runtimeContext.runtimeFactory;
	const composition = useMemo(() => createApplicationPluginComposition(), []);
	return useMemo(() => {
		const sessionHostManager = getInteractiveSessionHostManager();
		const initialPluginRuntime = getInteractivePluginRuntime();
		let opened: Promise<SessionEnvironment> | undefined;
		return {
			close: async () => {
				const pending = opened;
				opened = undefined;
				const environment = await pending?.catch(() => undefined);
				await environment?.shutdown().catch(() => undefined);
			},
			open: () => {
				// A failed open is not remembered, so the surface's retry can try
				// again instead of awaiting the same rejection forever.
				opened ??= openSessionEnvironment({
					policy: {
						cwd: configRef.current.cwd ?? configRef.current.workspace,
						workspace: configRef.current.workspace,
					},
					sources: {
						configRuntime: () => configRef.current,
						connections: () => connectionsRef.current,
						pricing: () => pricingRef.current,
						registry: () => registryRef.current,
						sessionHostManager: () => sessionHostManager,
						store: () => getSessionStore(),
						turnToolResolver: () => composition.turnToolResolver,
						pluginRuntime: () =>
							getInteractiveRuntimeContext().pluginRuntime ??
							initialPluginRuntime ??
							interactiveStandInRuntime(),
						...(runtimeFactory === undefined ? {} : { runtimeFactory }),
					},
				}).catch((error: unknown) => {
					opened = undefined;
					throw error;
				});
				return opened;
			},
		};
	}, [composition, runtimeFactory]);
};
