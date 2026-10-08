import * as path from "node:path";
import type { PluginFactory } from "@wincode/coding-agent";

const configuredSessionSdkPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "configured_session_sdk" });
	plugin.onSessionStart(async ({ sessionId, workspace }) => {
		await Bun.write(
			path.join(workspace, ".configured-session-sdk-plugin"),
			sessionId
		);
	});
};

export default configuredSessionSdkPlugin;
