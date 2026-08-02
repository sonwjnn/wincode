import { z } from "zod";

const policySchema = z.object({
	servers: z.record(z.string(), z.enum(["allow", "ask", "deny"])),
});

export type McpPolicyDecision = "allow" | "ask" | "deny";
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
	const result = policySchema.safeParse(parsed);
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
	return (configured ?? [])
		.filter((name) => !(name in policy))
		.map((server) => ({
			code: "unknown-server",
			message: `No policy configured for MCP server '${server}'`,
			server,
		}));
}

export function getMcpPolicyDecision(
	policy: McpPolicy,
	server: string
): McpPolicyDecision {
	return policy.servers[server] ?? "ask";
}
