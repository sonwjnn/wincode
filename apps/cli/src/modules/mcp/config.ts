import { type Diagnostic, readScope } from "./config/discovery";
import { resolveServers } from "./config/resolve";

export type {
	LocalMcpServerConfig,
	McpTimeouts,
	RemoteMcpServerConfig,
	ResolvedMcpServerConfig,
} from "./config/schema";
export { DEFAULT_MCP_TIMEOUTS } from "./config/schema";
export type McpConfigDiagnostic = Diagnostic;
export type McpConfigInput = {
	workspace: string;
	globalRoot: string;
	env: Record<string, string | undefined>;
	fs?: { readFile(path: string): Promise<string> };
};
export type McpConfigResult = ReturnType<typeof resolveServers>;

export async function loadMcpConfig(
	input: McpConfigInput
): Promise<McpConfigResult> {
	const diagnostics: Diagnostic[] = [];
	const fs = input.fs ?? {
		readFile: (file: string) => globalThis.Bun.file(file).text(),
	};
	const [global, project] = await Promise.all([
		readScope(input.globalRoot, "global", fs, diagnostics),
		readScope(input.workspace, "project", fs, diagnostics),
	]);
	return resolveServers({
		global,
		project,
		diagnostics,
		env: input.env,
		workspace: input.workspace,
	});
}
