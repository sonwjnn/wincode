import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginFactory } from "@wincode/coding-agent";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createConfigStore } from "@/shared/config/config-store";

test("Plugins own durable data in userDataDir without a host-managed secrets API", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-owned-storage-")
	);
	const workspace = path.join(root, "workspace");
	const userDataDir = path.join(root, "user-data");
	const pluginDataDir = path.join(userDataDir, "plugins", "storage_plugin");
	const statePath = path.join(pluginDataDir, "state.txt");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(pluginDataDir, { recursive: true });
	await Bun.write(statePath, "seeded-plugin-state");

	const hostSecretsApiPresent: boolean[] = [];
	const receivedUserDataDirs: string[] = [];
	const observedPluginStates: string[] = [];
	const plugin: PluginFactory = async (api, context) => {
		const definition = api.definePlugin({ id: "storage_plugin" });
		hostSecretsApiPresent.push("secrets" in definition);
		receivedUserDataDirs.push(context.userDataDir);
		const pluginStatePath = path.join(
			context.userDataDir,
			"plugins",
			"storage_plugin",
			"state.txt"
		);
		observedPluginStates.push(await Bun.file(pluginStatePath).text());
		await Bun.write(pluginStatePath, "plugin-owned-state");
	};
	const load = () =>
		loadPlugins({
			bundledPlugins: [{ factory: plugin, id: "storage_plugin" }],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			userDataDir,
		});

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await load();
		await runtime.shutdown();
		runtime = await load();

		expect(hostSecretsApiPresent).toEqual([false, false]);
		expect(receivedUserDataDirs).toEqual([userDataDir, userDataDir]);
		expect(observedPluginStates).toEqual([
			"seeded-plugin-state",
			"plugin-owned-state",
		]);
	} finally {
		await runtime?.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});
