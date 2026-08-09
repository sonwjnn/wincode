import {
	type ConfigStore,
	createConfigStore,
} from "@/shared/config/config-store";
import { resolveServers } from "./config/resolve";

export type { McpConfigDiagnostic } from "./config/resolve";
export type {
	LocalMcpServerConfig,
	McpTimeouts,
	RemoteMcpServerConfig,
	ResolvedMcpServerConfig,
} from "./config/schema";
export { DEFAULT_MCP_TIMEOUTS } from "./config/schema";
export type McpConfigInput = {
	workspace: string;
	env: Record<string, string | undefined>;
	configStore?: ConfigStore;
	configRoot?: string;
	homeRoot?: string;
	fs?: { readFile(path: string): Promise<string> };
};
export type McpConfigResult = ReturnType<typeof resolveServers>;

export async function loadMcpConfig(
	input: McpConfigInput
): Promise<McpConfigResult> {
	const configStore =
		input.configStore ??
		createConfigStore({
			...(input.configRoot === undefined
				? {}
				: { configRoot: input.configRoot }),
			...(input.fs === undefined ? {} : { fs: input.fs }),
			...(input.homeRoot === undefined ? {} : { homeRoot: input.homeRoot }),
			xdgConfigHome: input.env.XDG_CONFIG_HOME ?? "",
		});
	const snapshot = await configStore.getSnapshot(input.workspace);
	return resolveServers({
		env: input.env,
		snapshot,
		workspace: input.workspace,
	});
}
