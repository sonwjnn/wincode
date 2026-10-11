import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initializeApplicationRuntime } from "@/modules/application/runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { force: true, recursive: true }))
	);
});

test("application runtime discovers user agents from its configured data directory", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-subagent-data-")
	);
	temporaryDirectories.push(root);
	const workspace = path.join(root, "workspace");
	const userDataDir = path.join(root, "custom-user-data");
	await Promise.all([
		fs.mkdir(workspace, { recursive: true }),
		fs.mkdir(path.join(userDataDir, "agents"), { recursive: true }),
	]);
	await Bun.write(
		path.join(userDataDir, "agents", "custom-helper.md"),
		"---\nname: custom-helper\ndescription: A custom user subagent.\n---\nFollow the delegated task instructions.\n"
	);

	const runtime = await initializeApplicationRuntime(
		{
			cwd: workspace,
			disabledPluginIds: [],
			mode: "print",
			pluginPaths: [],
			stdinIsTTY: false,
		},
		{
			distributionPlugins: [
				{ id: "subagents", specifier: "@wincode/subagents/plugin" },
			],
			homeRoot: root,
			userDataDir,
		}
	);
	try {
		expect(
			runtime.pluginRuntime
				.getAgentRegistrations()
				.map(({ agent }) => String(agent.id))
		).toContain("custom-helper");
	} finally {
		await runtime.pluginRuntime.shutdown();
	}
});
