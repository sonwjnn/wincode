import * as path from "node:path";
import type { PluginFactory } from "@wincode/coding-agent";

const mismatchedDistributionPlugin: PluginFactory = (api, { workspace }) => {
	const plugin = api.definePlugin({ id: "actual_distribution_id" });
	plugin.onShutdown(async () => {
		await Bun.write(
			path.join(workspace, "mismatched-plugin-cleanup"),
			"closed"
		);
	});
};

export default mismatchedDistributionPlugin;
