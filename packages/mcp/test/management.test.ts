import { expect, test } from "bun:test";
import type { PluginSecretStore } from "@wincode/coding-agent";
import {
	createMcpManagement,
	type McpConfigSnapshot,
	type McpConfigSource,
} from "@wincode/mcp";

const source = (
	scope: "global" | "project",
	path: string,
	document: Readonly<Record<string, unknown>>
): McpConfigSource => ({ scope, path, document });

const snapshot = (sources: readonly McpConfigSource[]): McpConfigSnapshot => ({
	diagnostics: [],
	document: {},
	sourceFor: () => undefined,
	sources,
});

test("MCP management writes the selected transport in Pi shape at its selected scope", async () => {
	const writes: unknown[] = [];
	const management = createMcpManagement({
		authorizeWrite: () => undefined,
		config: {
			getSnapshot: async () =>
				snapshot([
					source("global", "/home/user/.wincode/mcp.json", {}),
					source("project", "/workspace/.wincode/mcp.json", {}),
				]),
			setValue: async (scope, path, value) => {
				writes.push({ path, scope, value });
			},
		},
		env: {},
		workspace: "/workspace",
	});

	await management.add({
		args: ["run", "docs.ts"],
		command: "bun",
		name: "docs",
		scope: "project",
	});

	expect(writes).toEqual([
		{
			path: ["mcpServers", "docs"],
			scope: "project",
			value: { args: ["run", "docs.ts"], command: "bun" },
		},
	]);
});

test("MCP management rejects ambiguous transports before persistence", async () => {
	let writes = 0;
	const management = createMcpManagement({
		authorizeWrite: () => undefined,
		config: {
			getSnapshot: async () => snapshot([]),
			setValue: async () => {
				writes += 1;
			},
		},
		env: {},
		workspace: "/workspace",
	});

	await expect(
		management.add({
			command: "bun",
			name: "broken",
			scope: "global",
			url: "https://mcp.example.test",
		})
	).rejects.toThrow("Provide exactly one");
	expect(writes).toBe(0);
});

test("MCP management delegates project write authorization to the host", async () => {
	let reads = 0;
	let writes = 0;
	const management = createMcpManagement({
		authorizeWrite: (scope) => {
			if (scope === "project") {
				throw new Error("Project is not trusted.");
			}
		},
		config: {
			getSnapshot: async () => {
				reads += 1;
				return snapshot([]);
			},
			setValue: async () => {
				writes += 1;
			},
		},
		env: {},
		workspace: "/workspace",
	});

	await expect(
		management.add({
			name: "project_docs",
			scope: "project",
			url: "https://mcp.example.test",
		})
	).rejects.toThrow("Project is not trusted.");
	expect(reads).toBe(0);
	expect(writes).toBe(0);
});

test("MCP management list preserves config-resolution diagnostics for callers", async () => {
	const management = createMcpManagement({
		authorizeWrite: () => undefined,
		config: {
			getSnapshot: async () =>
				snapshot([
					source("global", "/home/user/.wincode/mcp.json", {
						mcpServers: { broken: { url: "not-a-url" } },
					}),
				]),
			setValue: async () => undefined,
		},
		env: {},
		workspace: "/workspace",
	});

	const result = await management.list();

	expect(result.servers).toEqual({});
	expect(result.diagnostics.map(({ code }) => code)).toContain("invalid-url");
});

test("MCP management login and logout resolve OAuth servers through injected capabilities", async () => {
	const secrets: PluginSecretStore = {
		delete: async () => undefined,
		get: async () => undefined,
		set: async () => undefined,
	};
	const calls: string[] = [];
	const management = createMcpManagement({
		authorizeWrite: () => undefined,
		config: {
			getSnapshot: async () =>
				snapshot([
					source("global", "/home/user/.wincode/mcp.json", {
						mcpServers: {
							docs: {
								auth: "oauth",
								oauth: { clientId: "configured-client" },
								url: "https://mcp.example.test",
							},
						},
					}),
				]),
			setValue: async () => undefined,
		},
		env: {},
		oauth: {
			login: async (input) => {
				expect(input.serverName).toBe("docs");
				expect(input.serverUrl).toBe("https://mcp.example.test/");
				expect(input.oauth).toEqual({ clientId: "configured-client" });
				expect(input.secrets).toBe(secrets);
				calls.push("login");
			},
			logout: async (store, name) => {
				expect(store).toBe(secrets);
				expect(name).toBe("docs");
				calls.push("logout");
			},
		},
		workspace: "/workspace",
	});

	await management.login({
		name: "docs",
		openAuthorizationUrl: async () => undefined,
		secrets,
	});
	await management.logout({ name: "docs", secrets });

	expect(calls).toEqual(["login", "logout"]);
});
