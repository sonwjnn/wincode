import { expect, test } from "bun:test";
import * as path from "node:path";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpConfigDiagnostic,
	type McpConfigOrigin,
	type McpConfigSnapshot,
	type McpConfigSource,
	resolveMcpConfig,
} from "@wincode/mcp";

const workspace = "/workspace";
const configVariable = (name: string): string => ["$", "{", name, "}"].join("");
const projectOrigin: McpConfigOrigin = {
	path: `${workspace}/.wincode/mcp.json`,
	scope: "project",
};
const userOrigin: McpConfigOrigin = {
	path: "/home/user/.wincode/mcp.json",
	scope: "global",
};

const source = (
	origin: McpConfigOrigin,
	document: Readonly<Record<string, unknown>>
): McpConfigSource => ({ ...origin, document });

const createSnapshot = (
	sources: readonly McpConfigSource[],
	diagnostics: readonly McpConfigDiagnostic[] = []
): McpConfigSnapshot => ({
	diagnostics,
	document: Object.freeze(
		Object.assign(
			Object.create(null),
			...sources.map(({ document }) => document)
		)
	),
	sourceFor: () => sources.at(-1),
	sources,
});

const resolveSources = (
	sources: readonly McpConfigSource[],
	env: Readonly<Record<string, string | undefined>> = {},
	workingDirectory = workspace
) =>
	resolveMcpConfig({
		env,
		snapshot: createSnapshot(sources),
		workspace: workingDirectory,
	});

const resolveAsUser = (
	document: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>> = {},
	workingDirectory = workspace
) => resolveSources([source(userOrigin, document)], env, workingDirectory);

const resolveAsProject = (
	document: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>> = {}
) => resolveSources([source(projectOrigin, document)], env);

test("Pi-shaped stdio and HTTP entries resolve defaults, environment values, and exposure", async () => {
	const result = await resolveAsUser(
		{
			mcpServers: {
				local: {
					command: "bun",
					args: ["run", "server.ts"],
					cwd: "servers",
					env: { TOKEN: configVariable("MCP_TOKEN") },
					description: "Local development server",
					timeout: 12,
					exposure: "hidden",
					toolExposure: { public: "direct", "delete_*": "hidden" },
				},
				remote: {
					url: "https://mcp.example.test/tools?q=1",
					headers: { Authorization: `Bearer ${configVariable("MCP_TOKEN")}` },
				},
			},
		},
		{ MCP_TOKEN: "resolved-token" }
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toEqual({
		command: ["bun", "run", "server.ts"],
		cwd: path.resolve(workspace, "servers"),
		description: "Local development server",
		disabled: false,
		environment: { TOKEN: "resolved-token" },
		exposure: "hidden",
		name: "local",
		timeout: { ...DEFAULT_MCP_TIMEOUTS, execution: 12_000 },
		toolExposure: { public: "direct", "delete_*": "hidden" },
		type: "local",
	});
	expect(result.servers.remote).toMatchObject({
		disabled: false,
		exposure: "direct",
		headers: { Authorization: "Bearer resolved-token" },
		name: "remote",
		type: "remote",
		url: "https://mcp.example.test/tools?q=1",
	});
});

test("Pi variable escapes and leading shell commands resolve only in env and headers", async () => {
	const result = await resolveAsUser(
		{
			mcpServers: {
				local: {
					command: "$MCP_EXECUTABLE",
					args: ["$MCP_ARGUMENT", "$$LITERAL", "$!literal"],
					env: {
						TOKEN: "!printf 'Bearer %s' \"$MCP_TOKEN\"",
					},
				},
				remote: {
					url: "https://$MCP_HOST/mcp",
					headers: {
						Authorization: "!printf 'Bearer %s' \"$MCP_TOKEN\"",
					},
				},
			},
		},
		{
			MCP_ARGUMENT: "server.ts",
			MCP_EXECUTABLE: "bun",
			MCP_HOST: "mcp.example.test",
			MCP_TOKEN: "command-token",
		},
		process.cwd()
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toMatchObject({
		command: ["bun", "server.ts", "$LITERAL", "!literal"],
		environment: { TOKEN: "Bearer command-token" },
	});
	expect(result.servers.remote).toMatchObject({
		headers: { Authorization: "Bearer command-token" },
		url: "https://mcp.example.test/mcp",
	});
});

test("failed and oversized Pi header commands are diagnosed without blocking their server", async () => {
	const result = await resolveAsUser(
		{
			mcpServers: {
				remote: {
					url: "https://mcp.example.test/mcp",
					headers: {
						Authorization: "!exit 1",
						"X-Oversized": "!printf '%070000d' 0",
					},
				},
			},
		},
		{},
		process.cwd()
	);

	expect(result.servers.remote).toBeDefined();
	expect(result.servers.remote).not.toHaveProperty("headers.Authorization");
	expect(result.servers.remote).not.toHaveProperty("headers.X-Oversized");
	expect(
		result.diagnostics.filter(({ code }) => code === "command-failed")
	).toHaveLength(2);
});

test("project server definitions replace user endpoints instead of inheriting credentials", async () => {
	const result = await resolveSources([
		source(userOrigin, {
			mcpServers: {
				shared: {
					url: "https://user.example.test/mcp",
					headers: { Authorization: "Bearer user-token" },
				},
			},
		}),
		source(projectOrigin, {
			mcpServers: {
				shared: {
					url: "https://project.example.test/mcp",
					headers: { "X-Project": "trusted" },
				},
			},
		}),
	]);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.shared).toMatchObject({
		headers: { "X-Project": "trusted" },
		url: "https://project.example.test/mcp",
	});
	expect(result.servers.shared).not.toHaveProperty("headers.Authorization");
});

test("project enablement and exposure overlays retain user server details", async () => {
	const result = await resolveSources([
		source(userOrigin, {
			mcpServers: {
				shared: {
					url: "https://user.example.test/mcp",
					headers: { Authorization: "Bearer user-token" },
					exposure: "direct",
				},
			},
		}),
		source(projectOrigin, {
			mcpServers: { shared: { enabled: false, exposure: "hidden" } },
		}),
	]);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.shared).toMatchObject({
		disabled: true,
		exposure: "hidden",
		headers: { Authorization: "Bearer user-token" },
		url: "https://user.example.test/mcp",
	});
});

test("trusted project configuration may supply local commands and remote headers", async () => {
	const result = await resolveAsProject(
		{
			mcpServers: {
				local: {
					command: "bun",
					args: ["run", "server.ts"],
					env: { TOKEN: configVariable("PROJECT_TOKEN") },
				},
				remote: {
					url: "https://project.example.test/mcp",
					headers: {
						Authorization: `Bearer ${configVariable("PROJECT_TOKEN")}`,
					},
				},
			},
		},
		{ PROJECT_TOKEN: "project-token" }
	);

	expect(result.diagnostics).toEqual([]);
	expect(result.servers.local).toMatchObject({
		command: ["bun", "run", "server.ts"],
		environment: { TOKEN: "project-token" },
		type: "local",
	});
	expect(result.servers.remote).toMatchObject({
		headers: { Authorization: "Bearer project-token" },
		type: "remote",
	});
});

test("project OAuth client secrets are rejected instead of entering project configuration", async () => {
	const result = await resolveAsProject({
		mcpServers: {
			remote: {
				url: "https://project.example.test/mcp",
				oauth: {
					clientId: "client",
					clientSecret: configVariable("CLIENT_SECRET"),
				},
			},
		},
	});

	expect(result.servers.remote).toBeUndefined();
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "unsupported-auth",
			message:
				"MCP configuration cannot provide OAuth client secrets; use the host secret store.",
			serverName: "remote",
		})
	);
});

test("user OAuth client secrets are rejected before reaching MCP transport configuration", async () => {
	const result = await resolveAsUser({
		mcpServers: {
			remote: {
				url: "https://user.example.test/mcp",
				oauth: {
					clientId: "client",
					clientSecret: "must-not-appear-in-resolved-config",
				},
			},
		},
	});

	expect(result.servers.remote).toBeUndefined();
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "unsupported-auth",
			message:
				"MCP configuration cannot provide OAuth client secrets; use the host secret store.",
			serverName: "remote",
		})
	);
	expect(JSON.stringify(result.diagnostics)).not.toContain(
		"must-not-appear-in-resolved-config"
	);
});

test("unsupported exposure and transport entries are diagnosed without blocking valid servers", async () => {
	const result = await resolveAsUser({
		mcpServers: {
			valid: { command: "bun", args: ["run", "server.ts"] },
			unsupportedExposure: {
				command: "bun",
				exposure: "codemode",
			},
			unsupportedTransport: {
				type: "sse",
				url: "https://example.test/sse",
			},
		},
	});

	expect(result.servers.valid).toBeDefined();
	expect(result.servers.unsupportedExposure).toBeUndefined();
	expect(result.servers.unsupportedTransport).toBeUndefined();
	expect(result.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "unsupported-exposure",
				serverName: "unsupportedExposure",
			}),
			expect.objectContaining({
				code: "unsupported-transport",
				serverName: "unsupportedTransport",
			}),
		])
	);
});

test("the retired Wincode mcp map is inert in general settings", async () => {
	const result = await resolveAsUser({
		mcp: {
			legacy: {
				type: "local",
				command: ["bun", "run", "legacy.ts"],
			},
		},
	});

	expect(result.servers).toEqual({});
	expect(result.diagnostics).toEqual([]);
});

test("missing environment values diagnose the server without leaking configuration values", async () => {
	const result = await resolveAsUser({
		mcpServers: {
			remote: {
				url: "https://example.test/mcp",
				headers: { Authorization: `Bearer ${configVariable("MISSING_TOKEN")}` },
			},
		},
	});

	expect(result.servers.remote).toBeUndefined();
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			code: "missing-env",
			message: "Missing environment variable MISSING_TOKEN for server remote",
			serverName: "remote",
		})
	);
	expect(JSON.stringify(result)).not.toContain("Bearer");
});
