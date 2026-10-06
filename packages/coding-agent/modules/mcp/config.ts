import {
	type McpConfigLoader,
	type McpConfigLoadRequest,
	type McpConfigResult,
	resolveMcpConfig,
} from "@wincode/mcp";
import { omitUndefined } from "@wincode/utils";
import {
	type ConfigStore,
	createConfigStore,
} from "@/shared/config/config-store";

export type {
	InvalidMcpServerConfig,
	McpConfigDiagnostic,
	McpConfigResult,
	ResolvedMcpServerConfig,
} from "@wincode/mcp";

export type WincodeMcpConfigInput = Omit<McpConfigLoadRequest, "refresh"> &
	Readonly<{
		configRoot?: string;
		configStore?: ConfigStore;
		fs?: { readFile(path: string): Promise<string> };
		homeRoot?: string;
		refresh?: boolean;
	}>;

export const loadMcpConfig = async (
	input: WincodeMcpConfigInput
): Promise<McpConfigResult> => {
	const configStore =
		input.configStore ??
		createConfigStore({
			...omitUndefined({
				configRoot: input.configRoot,
				fs: input.fs,
				homeRoot: input.homeRoot,
			}),
			xdgConfigHome: input.env.XDG_CONFIG_HOME ?? "",
		});
	const snapshot = await (input.refresh === true
		? configStore.refreshSnapshot(input.workspace)
		: configStore.getSnapshot(input.workspace));
	return resolveMcpConfig({
		env: input.env,
		snapshot,
		workspace: input.workspace,
	});
};

export type WincodeMcpConfigSourceOptions = Omit<
	WincodeMcpConfigInput,
	keyof McpConfigLoadRequest
>;

export const createWincodeMcpConfigLoader =
	(options: WincodeMcpConfigSourceOptions): McpConfigLoader =>
	({ env, refresh, workspace }) =>
		loadMcpConfig({
			...options,
			env: { ...env },
			refresh,
			workspace,
		});
