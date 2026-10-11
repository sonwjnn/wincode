import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";

/**
 * A Plugin runtime that loaded no Plugin files, for a test that needs a Session
 * Environment without exercising Plugin loading. Every call returns a new
 * runtime, so a caller that passes one as a source getter must hold it.
 */
export const createEmptyPluginRuntime = (): PluginRuntime =>
	createPluginRuntime([], []);
