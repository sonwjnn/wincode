import type { AgentRuntime } from "@wincode/agent-core";
import { isUndefined } from "@wincode/utils";
import type { ApplicationResourceLoader } from "@/modules/application/resource-loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
export type StartInteractiveInput = {
	args: readonly string[];
	cwd: string;
	configRuntime?: ConfigRuntime;
	pluginRuntime?: PluginRuntime;
	resourceLoader?: ApplicationResourceLoader;
	runtimeFactory?: () => AgentRuntime;
};

let runtimeContext: StartInteractiveInput | undefined;
const runtimeListeners = new Set<() => void>();

export const setInteractiveRuntimeContext = (
	context: StartInteractiveInput
): void => {
	runtimeContext = Object.freeze({ ...context, args: [...context.args] });
	for (const listener of [...runtimeListeners]) {
		listener();
	}
};

export const subscribeInteractiveRuntimeContext = (
	listener: () => void
): (() => void) => {
	runtimeListeners.add(listener);
	return () => runtimeListeners.delete(listener);
};

export const getInteractiveRuntimeContext = (): StartInteractiveInput => {
	if (isUndefined(runtimeContext)) {
		throw new Error("Interactive runtime context was not initialized");
	}
	return runtimeContext;
};

export const getInteractivePluginRuntime = (): PluginRuntime | undefined =>
	runtimeContext?.pluginRuntime;
