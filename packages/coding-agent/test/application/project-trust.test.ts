import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMcpConfig } from "@wincode/mcp";
import { initializeApplicationRuntime } from "@/modules/application/runtime";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { discoverSkills } from "@/modules/skills";

const temporaryDirectories: string[] = [];

const createDirectory = async (): Promise<string> => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "wincode-project-trust-")
	);
	temporaryDirectories.push(directory);
	return directory;
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe("Coding-Agent Application Project trust", () => {
	test("print startup skips untrusted project config before evaluating its Plugin", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const configRoot = path.join(homeRoot, ".config", "wincode");
		const userDataDir = path.join(homeRoot, ".local", "share", "wincode");
		const marker = path.join(directory, "plugin-evaluated");
		await Promise.all([
			mkdir(workspace, { recursive: true }),
			mkdir(configRoot, { recursive: true }),
		]);
		await Bun.write(
			path.join(configRoot, "wincode.json"),
			JSON.stringify({
				mcp: {
					user_server: {
						command: ["bun", "run", "user-server.ts"],
						type: "local",
					},
				},
				settings: { userOnly: true },
			})
		);
		await Bun.write(
			path.join(workspace, "wincode.json"),
			JSON.stringify({
				mcp: {
					project_server: {
						command: ["bun", "run", "project-server.ts"],
						type: "local",
					},
				},
				plugins: ["./project-plugin.ts"],
				settings: { projectOnly: true },
			})
		);
		await Bun.write(
			path.join(workspace, "project-plugin.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "evaluated");\nexport default (api: { definePlugin(input: { id: string }): void }) => api.definePlugin({ id: "project_plugin" });\n`
		);

		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				mode: "print",
				pluginPaths: [],
				disabledPluginIds: [],
				stdinIsTTY: false,
			},
			{
				configRoot,
				distributionPlugins: [],
				homeRoot,
				userDataDir,
			}
		);
		try {
			const snapshot =
				await runtime.configRuntime.configStore.getSnapshot(workspace);
			const mcp = resolveMcpConfig({ env: {}, snapshot, workspace });
			expect(Object.keys(mcp.servers)).toEqual(["user_server"]);
			expect(snapshot.document.settings).toEqual({ userOnly: true });
			expect(
				runtime.pluginRuntime.getToolDescriptors("project-trust-test")
			).toEqual([]);
			expect(await Bun.file(marker).exists()).toBe(false);
			expect(runtime.startupDiagnostics?.join("\n")).toContain(workspace);
			expect(runtime.startupDiagnostics?.join("\n")).toContain("untrusted");
		} finally {
			await runtime.pluginRuntime?.shutdown();
		}
	});

	test("project Plugin and MCP processes stay unloaded before trust and after refusal", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const configRoot = path.join(homeRoot, ".config", "wincode");
		const pluginMarker = path.join(directory, "plugin-evaluated");
		const serverMarker = path.join(directory, "mcp-started");
		await Promise.all([
			mkdir(workspace, { recursive: true }),
			mkdir(configRoot, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(workspace, "wincode.json"),
				JSON.stringify({
					mcp: {
						project_server: {
							command: [
								process.execPath,
								"-e",
								`await Bun.write(${JSON.stringify(serverMarker)}, "started");`,
							],
							type: "local",
						},
					},
					plugins: ["./project-plugin.ts"],
				})
			),
			Bun.write(
				path.join(workspace, "project-plugin.ts"),
				`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pluginMarker)}, "evaluated");\nexport default (api: { definePlugin(input: { id: string }): void }) => api.definePlugin({ id: "project_plugin" });\n`
			),
		]);
		let promptCount = 0;
		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				configRoot,
				distributionPlugins: [{ id: "mcp", specifier: "@wincode/mcp/plugin" }],
				homeRoot,
				userDataDir: path.join(directory, "user-data"),
				promptProjectTrust: async () => {
					promptCount += 1;
					expect(await Bun.file(pluginMarker).exists()).toBe(false);
					expect(await Bun.file(serverMarker).exists()).toBe(false);
					return "deny";
				},
			}
		);
		try {
			expect(promptCount).toBe(1);
			expect(runtime.pluginRuntime.getCommands()).toContainEqual(
				expect.objectContaining({ name: "mcps", statusPanelId: "servers" })
			);
			const panel = runtime.pluginRuntime
				.getStatusPanels()
				.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
			expect(panel).toBeDefined();
			expect(panel?.getSnapshot().items.map(({ id }) => id)).toEqual([]);
			expect(await Bun.file(pluginMarker).exists()).toBe(false);
			expect(await Bun.file(serverMarker).exists()).toBe(false);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
	});

	test("explicit invocation trust loads a relative Plugin from its declaring config directory", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const configDirectory = path.join(workspace, ".wincode");
		const marker = path.join(directory, "plugin-evaluated");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(path.join(configDirectory, "plugins"), { recursive: true });
		await Bun.write(
			path.join(configDirectory, "wincode.json"),
			JSON.stringify({
				mcp: {
					project_server: {
						command: ["bun", "run", "project-server.ts"],
						type: "local",
					},
				},
				plugins: ["./plugins/project-plugin.ts"],
			})
		);
		await Bun.write(
			path.join(configDirectory, "plugins", "project-plugin.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "evaluated");\nexport default (api) => { const plugin = api.definePlugin({ id: "project_plugin" }); plugin.registerResource("loaded", true); };\n`
		);

		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "print",
				pluginPaths: [],
				projectTrustOverride: "trust",
				stdinIsTTY: false,
			},
			{ distributionPlugins: [], userDataDir }
		);
		try {
			expect(await Bun.file(marker).exists()).toBe(true);
			expect(
				runtime.pluginRuntime.getResource<boolean>("project_plugin", "loaded")
			).toBe(true);
			const snapshot =
				await runtime.configRuntime.configStore.getSnapshot(workspace);
			const mcp = resolveMcpConfig({ env: {}, snapshot, workspace });
			expect(Object.keys(mcp.servers)).toEqual(["project_server"]);
			expect(runtime.startupDiagnostics).toEqual([]);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
		expect(
			await Bun.file(path.join(userDataDir, "project-trust.json")).exists()
		).toBe(false);
	});

	test("interactive trust is saved outside the project and is reusable without a prompt", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(workspace, { recursive: true });
		const configPath = path.join(workspace, "wincode.json");
		await Bun.write(
			configPath,
			JSON.stringify({ settings: { beforePrompt: true } })
		);
		let prompts = 0;
		const prompted = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir,
				promptProjectTrust: async (projectRoot) => {
					prompts += 1;
					expect(projectRoot).toBe(await realpath(workspace));
					await Bun.write(
						configPath,
						JSON.stringify({ settings: { afterPrompt: true } })
					);
					return "trust";
				},
			}
		);
		try {
			const snapshot =
				await prompted.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toEqual({ afterPrompt: true });
		} finally {
			await prompted.pluginRuntime.shutdown();
		}
		expect(prompts).toBe(1);
		expect(await Bun.file(configPath).exists()).toBe(true);
		expect(
			await Bun.file(path.join(userDataDir, "project-trust.json")).exists()
		).toBe(true);

		const saved = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				stdinIsTTY: false,
			},
			{ distributionPlugins: [], userDataDir }
		);
		try {
			const snapshot =
				await saved.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toEqual({ afterPrompt: true });
			expect(saved.startupDiagnostics).toEqual([]);
		} finally {
			await saved.pluginRuntime.shutdown();
		}
		expect(prompts).toBe(1);
	});

	test("untrusted project Skills are omitted while personal Skills remain available", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		await Promise.all([
			mkdir(path.join(workspace, ".wincode", "skills", "project-skill"), {
				recursive: true,
			}),
			mkdir(path.join(homeRoot, ".wincode", "skills", "personal-skill"), {
				recursive: true,
			}),
		]);
		const skill = (name: string): string =>
			`---\nname: ${name}\ndescription: ${name} description\n---\nInstructions.`;
		await Promise.all([
			Bun.write(
				path.join(workspace, ".wincode", "skills", "project-skill", "SKILL.md"),
				skill("project-skill")
			),
			Bun.write(
				path.join(homeRoot, ".wincode", "skills", "personal-skill", "SKILL.md"),
				skill("personal-skill")
			),
		]);
		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				stdinIsTTY: false,
			},
			{
				distributionPlugins: [],
				homeRoot,
				userDataDir: path.join(directory, "user-data"),
			}
		);
		try {
			const skills = await discoverSkills(runtime.configRuntime);
			expect(skills.map(({ name }) => name)).toEqual(["personal-skill"]);
			expect(runtime.startupDiagnostics).toHaveLength(1);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
	});

	test("trusted symlink workspaces discover project Skills and Custom Commands", async () => {
		const directory = await createDirectory();
		const realWorkspace = path.join(directory, "real-repo");
		const workspaceAlias = path.join(directory, "repo-link");
		const skillsRoot = path.join(
			realWorkspace,
			".wincode",
			"skills",
			"project-skill"
		);
		const commandsRoot = path.join(realWorkspace, ".wincode", "commands");
		await Promise.all([
			mkdir(skillsRoot, { recursive: true }),
			mkdir(commandsRoot, { recursive: true }),
		]);
		await symlink(realWorkspace, workspaceAlias, "dir");
		await Promise.all([
			Bun.write(
				path.join(skillsRoot, "SKILL.md"),
				"---\nname: project-skill\ndescription: Project skill\n---\nInstructions."
			),
			Bun.write(
				path.join(commandsRoot, "project-task.md"),
				"---\ndescription: Project task\n---\nRun the project task."
			),
		]);

		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspaceAlias,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				projectTrustOverride: "trust",
				stdinIsTTY: false,
			},
			{
				distributionPlugins: [],
				homeRoot: path.join(directory, "home"),
				userDataDir: path.join(directory, "user-data"),
			}
		);
		try {
			const skills = await discoverSkills(runtime.configRuntime);
			const commands = await getCustomCommands(runtime.configRuntime);
			expect(skills.map(({ name }) => name)).toEqual(["project-skill"]);
			expect(commands.map(({ name }) => name)).toEqual(["project-task"]);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
	});

	test("a saved refusal omits project config without asking again", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, "wincode.json"),
			JSON.stringify({ settings: { projectOnly: true } })
		);
		let prompts = 0;
		const refused = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir,
				promptProjectTrust: async () => {
					prompts += 1;
					return "deny";
				},
			}
		);
		await refused.pluginRuntime.shutdown();
		expect(refused.startupDiagnostics).toHaveLength(1);

		const savedRefusal = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir,
				promptProjectTrust: async () => {
					prompts += 1;
					return "trust";
				},
			}
		);
		try {
			const snapshot =
				await savedRefusal.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toBeUndefined();
			expect(savedRefusal.startupDiagnostics.join("\n")).toContain("untrusted");
		} finally {
			await savedRefusal.pluginRuntime.shutdown();
		}
		expect(prompts).toBe(1);
	});

	test("saved ancestor trust covers protected descendant project directories", async () => {
		const directory = await createDirectory();
		const projectRoot = path.join(directory, "repo");
		const descendant = path.join(projectRoot, "nested");
		const userDataDir = path.join(directory, "user-data");
		await Promise.all([
			mkdir(projectRoot, { recursive: true }),
			mkdir(path.join(descendant, ".git"), { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(projectRoot, "wincode.json"),
				JSON.stringify({ settings: { ancestor: true } })
			),
			Bun.write(
				path.join(descendant, "wincode.json"),
				JSON.stringify({ settings: { descendant: true } })
			),
		]);
		const trustedAncestor = await initializeApplicationRuntime(
			{
				cwd: projectRoot,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir,
				promptProjectTrust: async () => "trust",
			}
		);
		await trustedAncestor.pluginRuntime.shutdown();

		const trustedDescendant = await initializeApplicationRuntime(
			{
				cwd: descendant,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				stdinIsTTY: false,
			},
			{ distributionPlugins: [], userDataDir }
		);
		try {
			const snapshot =
				await trustedDescendant.configRuntime.configStore.getSnapshot(
					descendant
				);
			expect(snapshot.document.settings).toEqual({ descendant: true });
			expect(trustedDescendant.startupDiagnostics).toEqual([]);
		} finally {
			await trustedDescendant.pluginRuntime.shutdown();
		}
	});

	test("saved descendant trust does not trust an ancestor project", async () => {
		const directory = await createDirectory();
		const projectRoot = path.join(directory, "repo");
		const descendant = path.join(projectRoot, "nested");
		const userDataDir = path.join(directory, "user-data");
		await Promise.all([
			mkdir(path.join(projectRoot, ".git"), { recursive: true }),
			mkdir(path.join(descendant, ".git"), { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(projectRoot, "wincode.json"),
				JSON.stringify({ settings: { ancestor: true } })
			),
			Bun.write(
				path.join(descendant, "wincode.json"),
				JSON.stringify({ settings: { descendant: true } })
			),
		]);
		const trustedDescendant = await initializeApplicationRuntime(
			{
				cwd: descendant,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir,
				promptProjectTrust: async () => "trust",
			}
		);
		await trustedDescendant.pluginRuntime.shutdown();

		const ancestor = await initializeApplicationRuntime(
			{
				cwd: projectRoot,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				stdinIsTTY: false,
			},
			{ distributionPlugins: [], userDataDir }
		);
		try {
			const snapshot =
				await ancestor.configRuntime.configStore.getSnapshot(projectRoot);
			expect(snapshot.document.settings).toBeUndefined();
			expect(ancestor.startupDiagnostics.join("\n")).toContain(projectRoot);
		} finally {
			await ancestor.pluginRuntime.shutdown();
		}
	});

	test("AGENTS.md alone does not prompt for Project trust", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		await mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, "AGENTS.md"), "untrusted context");
		await Promise.all([
			mkdir(path.join(workspace, ".wincode", "skills"), { recursive: true }),
			mkdir(path.join(workspace, ".wincode", "commands"), { recursive: true }),
			mkdir(path.join(workspace, ".wincode", "plugins"), { recursive: true }),
		]);
		let prompts = 0;
		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				distributionPlugins: [],
				userDataDir: path.join(directory, "user-data"),
				promptProjectTrust: async () => {
					prompts += 1;
					return "trust";
				},
			}
		);
		try {
			expect(runtime.startupDiagnostics).toEqual([]);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
		expect(prompts).toBe(0);
	});
});
