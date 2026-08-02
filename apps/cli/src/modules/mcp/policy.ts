import { z } from "zod";

export const mcpExecutionPolicySchema = z.enum(["allow", "ask", "deny"]);
export const mcpPolicySchema = z.object({
	servers: z.record(z.string(), mcpExecutionPolicySchema).default({}),
});

export type McpExecutionPolicy = z.infer<typeof mcpExecutionPolicySchema>;
export type McpPolicyDecision = McpExecutionPolicy;
export type McpPolicyDiagnostic = {
	code: "malformed" | "unknown-server";
	message: string;
	server?: string;
};
export type McpPolicy = { servers: Record<string, McpPolicyDecision> };
export type LoadMcpPolicyInput = {
	workspace: string;
	fs?: { readFile(path: string): Promise<string> };
	configuredServers?: string[];
};
export type McpPolicyResult = {
	policy: McpPolicy;
	diagnostics: McpPolicyDiagnostic[];
};

export async function loadMcpPolicy(
	input: LoadMcpPolicyInput
): Promise<McpPolicyResult> {
	const file = `${input.workspace}/.wincode/mcp.json`;
	const fs = input.fs ?? {
		readFile: (path: string) => globalThis.Bun.file(path).text(),
	};
	let raw: string;
	try {
		raw = await fs.readFile(file);
	} catch {
		return {
			policy: { servers: {} },
			diagnostics: unknownServers({}, input.configuredServers),
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return {
			policy: { servers: {} },
			diagnostics: [
				{ code: "malformed", message: "mcp.json is not valid JSON" },
			],
		};
	}
	const result = mcpPolicySchema.safeParse(parsed);
	if (!result.success) {
		return {
			policy: { servers: {} },
			diagnostics: [
				{ code: "malformed", message: "mcp.json has invalid policy shape" },
			],
		};
	}
	return {
		policy: result.data,
		diagnostics: unknownServers(result.data.servers, input.configuredServers),
	};
}

function unknownServers(
	policy: Record<string, McpPolicyDecision>,
	configured?: string[]
): McpPolicyDiagnostic[] {
	return Object.keys(policy)
		.filter((name) => !(configured ?? []).includes(name))
		.map((server) => ({
			code: "unknown-server",
			message: `No policy configured for MCP server '${server}'`,
			server,
		}));
}

export const resolveMcpPolicy = (
	policies: Readonly<Record<string, McpExecutionPolicy>>,
	serverName: string
): McpExecutionPolicy => policies[serverName] ?? "ask";

export function getMcpPolicyDecision(
	policy: McpPolicy,
	server: string
): McpPolicyDecision {
	return resolveMcpPolicy(policy.servers, server);
}
