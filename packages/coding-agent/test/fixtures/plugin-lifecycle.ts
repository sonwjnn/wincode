import * as fs from "node:fs/promises";
import type { PluginFactory } from "@wincode/coding-agent";

/**
 * Records its own process lifecycle so a test can observe whether the runtime
 * that loaded it was shut down. The log path comes from the environment, so the
 * Plugin file itself carries no test state.
 */
const appendLifecycle = async (event: string): Promise<void> => {
	const logPath = process.env.WINCODE_TEST_PLUGIN_LIFECYCLE_LOG;
	if (logPath === undefined) {
		return;
	}
	await fs.appendFile(logPath, `${event}\n`);
};

const lifecyclePlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "lifecycle_recorder" });
	plugin.registerResource("lifecycle", {});
	plugin.onStart(() => appendLifecycle("start"));
	plugin.onShutdown(() => appendLifecycle("shutdown"));
};

export default lifecyclePlugin;
