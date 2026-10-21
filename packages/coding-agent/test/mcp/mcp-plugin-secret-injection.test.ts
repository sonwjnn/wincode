import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpPluginFactory } from "@wincode/mcp/plugin";
import { createMcpSecretStore } from "@/modules/mcp/mcp-secret-store";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createConfigStore } from "@/shared/config/config-store";

test("MCP Plugin receives its purpose-specific secret store from Coding-Agent context", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-mcp-plugin-storage-")
	);
	const workspace = path.join(root, "workspace");
	const userDataDir = path.join(root, "user-data");
	await fs.mkdir(workspace, { recursive: true });
	let receivedSecretStorePath: string | undefined;
	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					factory: createMcpPluginFactory({
						createSecretStore: (directory) => {
							receivedSecretStorePath = directory;
							return createMcpSecretStore(directory);
						},
					}),
					id: "mcp",
				},
			],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			distributionPlugins: [],
			userDataDir,
		});
		expect(receivedSecretStorePath).toBe(userDataDir);
		expect(
			runtime
				.getStatusPanels()
				.some(({ id, pluginId }) => id === "servers" && pluginId === "mcp")
		).toBe(true);
	} finally {
		await runtime?.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});
