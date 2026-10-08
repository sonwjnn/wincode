import { expect, test } from "bun:test";
import type {
	PluginConfigDiagnostic,
	PluginConfigReader,
	PluginConfigSnapshot,
} from "@wincode/coding-agent";
import { createMcpConfigLoader } from "../src/plugin/config";

const diagnostic: PluginConfigDiagnostic = {
	code: "parse-error",
	message: "Ignored a malformed lower-priority config file.",
	path: "/config/wincode.json",
	scope: "global",
};

const snapshot: PluginConfigSnapshot = {
	diagnostics: [diagnostic],
	document: {
		mcp: {
			wiki: {
				type: "remote",
				url: "https://mcp.example.test/",
			},
		},
	},
	sourceFor: () => ({ path: "/home/user/wincode.json", scope: "user" }),
	sources: [
		{
			document: {
				mcp: { wiki: { type: "remote", url: "https://mcp.example.test/" } },
			},
			path: "/home/user/wincode.json",
			scope: "user",
		},
	],
};

test("MCP reads merged host config snapshots and requests refresh only when asked", async () => {
	let reads = 0;
	let refreshes = 0;
	const config: PluginConfigReader = {
		getSnapshot: async () => {
			reads += 1;
			return snapshot;
		},
		refreshSnapshot: async () => {
			refreshes += 1;
			return snapshot;
		},
	};
	const load = createMcpConfigLoader(config);

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
