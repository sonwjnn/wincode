import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginFactory } from "@/modules/plugins/public";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createConfigStore } from "@/shared/config/config-store";

test("Plugin definitions expose owner-scoped secret storage", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-owned-storage-")
	);
	const workspace = path.join(root, "workspace");
	const userDataDir = path.join(root, "user-data");
	await fs.mkdir(workspace, { recursive: true });
	let firstPluginSecret: string | undefined;
	let secondPluginSecret: string | undefined;
	const firstPlugin: PluginFactory = async (api) => {
		const definition = api.definePlugin({ id: "first_plugin" });
		await definition.secrets.set("oauth.token", "first-plugin-secret");
		firstPluginSecret = await definition.secrets.get("oauth.token");
	};
	const secondPlugin: PluginFactory = async (api) => {
		const definition = api.definePlugin({ id: "second_plugin" });
		secondPluginSecret = await definition.secrets.get("oauth.token");
	};
	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{ factory: firstPlugin, id: "first_plugin" },
				{ factory: secondPlugin, id: "second_plugin" },
			],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			userDataDir,
		});
		expect(firstPluginSecret).toBe("first-plugin-secret");
		expect(secondPluginSecret).toBeUndefined();
	} finally {
		await runtime?.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});
