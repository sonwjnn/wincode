import { expect, test } from "bun:test";
import type {
	PluginConfigDiagnostic,
	PluginConfigFileStore,
	PluginConfigSnapshot,
	PluginMcpServerRegistration,
} from "@wincode/coding-agent";
import { createMcpConfigLoader } from "../src/plugin/config";

const diagnostic: PluginConfigDiagnostic = {
	code: "parse-error",
	message: "Ignored a malformed lower-priority config file.",
	path: "/home/user/.wincode/mcp.json",
	scope: "global",
};

const snapshot: PluginConfigSnapshot = {
	diagnostics: [diagnostic],
	document: {
		mcpServers: {
			wiki: {
				url: "https://mcp.example.test/",
			},
		},
	},
	sourceFor: () => ({ path: "/home/user/.wincode/mcp.json", scope: "global" }),
	sources: [
		{
			document: {
				mcpServers: { wiki: { url: "https://mcp.example.test/" } },
			},
			path: "/home/user/.wincode/mcp.json",
			scope: "global",
		},
	],
};

test("Extension-owned MCP Servers enter the managed catalog without overriding file config", async () => {
	const configFiles: PluginConfigFileStore = {
		getSnapshot: async () => snapshot,
		refreshSnapshot: async () => snapshot,
		setValue: async () => snapshot,
	};
	const registrations: readonly PluginMcpServerRegistration[] = [
		{
			config: { command: "bun", args: ["run", "extension-mcp.ts"] },
			name: "extension_docs",
			ownerPluginId: "docs_plugin",
		},
		{
			config: { command: "bun", args: ["run", "replacement.ts"] },
			name: "wiki",
			ownerPluginId: "other_plugin",
		},
	];
	const load = createMcpConfigLoader(configFiles, () => registrations);
	const result = await load({
		env: {},
		refresh: false,
		workspace: "/workspace",
	});

	expect(result.servers.extension_docs).toMatchObject({
		type: "local",
		command: ["bun", "run", "extension-mcp.ts"],
	});
	expect(result.servers.wiki).toMatchObject({
		type: "remote",
		url: "https://mcp.example.test/",
	});
});

test("MCP reads the host-owned mcp namespace and refreshes only when asked", async () => {
	let reads = 0;
	let refreshes = 0;
	const configFiles: PluginConfigFileStore = {
		getSnapshot: async (namespace) => {
			expect(namespace).toBe("mcp");
			reads += 1;
			return snapshot;
		},
		refreshSnapshot: async (namespace) => {
			expect(namespace).toBe("mcp");
			refreshes += 1;
			return snapshot;
		},
		setValue: async () => snapshot,
	};
	const load = createMcpConfigLoader(configFiles);

	const initial = await load({
		env: {},
		refresh: false,
		workspace: "/workspace",
	});
	const refreshed = await load({
		env: {},
		refresh: true,
		workspace: "/workspace",
	});

	expect(initial.servers.wiki).toMatchObject({
		type: "remote",
		url: "https://mcp.example.test/",
	});
	expect(refreshed.servers.wiki).toEqual(initial.servers.wiki);
	expect({ reads, refreshes }).toEqual({ reads: 1, refreshes: 1 });
	expect(initial.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "parse-error",
				message: diagnostic.message,
				path: diagnostic.path,
			}),
		])
	);
});
