import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMcpConfig } from "@wincode/mcp";
import { discoverSubagentAgents } from "@wincode/subagents";
import { initializeApplicationRuntime } from "@/modules/application/runtime";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import {
	getProjectTrustStatus,
	resolveProjectTrust,
	saveProjectTrustDecision,
} from "@/modules/project-trust/project-trust";
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
	test("project Agent files alone require trust and load when opted in", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const userDataDir = path.join(directory, "user-data");
		const builtinRoot = path.join(directory, "package-agents");
		const agentPath = path.join(
			workspace,
			".wincode",
			"agents",
			"nested",
			"project-only.md"
		);
		await Promise.all([
			mkdir(builtinRoot, { recursive: true }),
			mkdir(path.dirname(agentPath), { recursive: true }),
		]);
		await Bun.write(
			agentPath,
			"---\nname: project-only\ndescription: Project-only helper\nrole: subagent\n---\nInspect the project.\n"
		);

		const untrusted = await resolveProjectTrust({
			mode: "print",
			projectTrustDir: userDataDir,
			workspace,
		});
		const untrustedAgents = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: untrusted.trustedProjectRoots,
			userDataDir,
		});
		expect(untrusted.trustedProjectRoots).toEqual([]);
		expect(untrusted.diagnostics.join("\n")).toContain("untrusted");
		expect(
			untrustedAgents.agents.some(({ agent }) => agent.id === "project-only")
		).toBe(false);

		const trusted = await resolveProjectTrust({
			mode: "print",
			override: "trust",
			projectTrustDir: userDataDir,
			workspace,
		});
		const trustedAgents = await discoverSubagentAgents({
			builtinRoot,
			trustedProjectRoots: trusted.trustedProjectRoots,
			userDataDir,
		});
		expect(trusted.trustedProjectRoots).toContain(await realpath(workspace));
		expect(
			trustedAgents.agents.some(({ agent }) => agent.id === "project-only")
		).toBe(true);
	});

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
			{
				distributionPlugins: [],
				projectTrustDir: userDataDir,
				userDataDir,
			}
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

	test("interactive trust saves under user .wincode and is reusable without a prompt", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
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
				homeRoot,
				userDataDir,
				promptProjectTrust: async (request) => {
					prompts += 1;
					expect(request.workspace).toBe(await realpath(workspace));
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
			await Bun.file(
				path.join(homeRoot, ".wincode", "project-trust.json")
			).exists()
		).toBe(true);
		expect(
			await Bun.file(path.join(userDataDir, "project-trust.json")).exists()
		).toBe(false);

		const saved = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "json",
				pluginPaths: [],
				stdinIsTTY: false,
			},
			{ distributionPlugins: [], homeRoot, userDataDir }
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
		const homeRoot = path.join(directory, "home");
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
				homeRoot,
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
				homeRoot,
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

	test("/trust replaces a saved refusal so the next reload trusts project resources", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, "wincode.json"), "{}");

		await saveProjectTrustDecision({
			decision: "deny",
			projectTrustDir: userDataDir,
			workspace,
		});
		await saveProjectTrustDecision({
			decision: "trust",
			projectTrustDir: userDataDir,
			workspace,
		});

		const resolution = await resolveProjectTrust({
			mode: "json",
			projectTrustDir: userDataDir,
			workspace,
		});

		expect(resolution.trustedProjectRoots).toContain(await realpath(workspace));
		expect(resolution.diagnostics).toEqual([]);
	});

	test("trusting a parent clears a child refusal and reports inherited status", async () => {
		const directory = await createDirectory();
		const parent = path.join(directory, "workspace");
		const workspace = path.join(parent, "repo");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			mkdir(path.join(parent, ".git"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await Bun.write(path.join(workspace, "wincode.json"), "{}");

		await saveProjectTrustDecision({
			decision: "deny",
			projectTrustDir,
			workspace,
		});
		await saveProjectTrustDecision({
			decision: "trust",
			projectTrustDir,
			scope: "parent",
			workspace,
		});

		const resolution = await resolveProjectTrust({
			mode: "json",
			projectTrustDir,
			workspace,
		});
		const status = await getProjectTrustStatus({
			projectTrustDir,
			trustedProjectRoots: resolution.trustedProjectRoots,
			workspace,
		});

		expect(resolution.trustedProjectRoots).toContain(await realpath(workspace));
		expect(status.currentSessionTrusted).toBe(true);
		expect(status.parentDirectory).toBe(await realpath(parent));
		expect(status.protectedRoots).toEqual([
			{
				currentSessionStatus: "trusted",
				projectRoot: await realpath(workspace),
				savedDecision: {
					decision: "trust",
					directory: await realpath(parent),
					inherited: true,
				},
			},
		]);
	});

	test("reload does not implicitly trust protected resources added after startup", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(workspace, { recursive: true });
		const runtime = await initializeApplicationRuntime(
			{
				cwd: workspace,
				disabledPluginIds: [],
				mode: "interactive",
				pluginPaths: [],
				stdinIsTTY: true,
			},
			{
				configRoot: path.join(directory, "config"),
				distributionPlugins: [],
				homeRoot,
				userDataDir,
			}
		);
		let reloadedPluginRuntime = runtime.pluginRuntime;
		try {
			expect(runtime.configRuntime.trustedProjectRoots).toEqual([]);
			await Bun.write(
				path.join(workspace, "wincode.json"),
				JSON.stringify({ settings: { reloadShouldNotTrust: true } })
			);

			const result = await runtime.resourceLoader.reload({
				current: {
					configRuntime: runtime.configRuntime,
					pluginRuntime: runtime.pluginRuntime,
				},
			});
			reloadedPluginRuntime = result.pluginRuntime;
			const snapshot =
				await result.configRuntime.configStore.getSnapshot(workspace);

			expect(result.configRuntime.trustedProjectRoots).toEqual([]);
			expect(
				result.diagnostics.map(({ message }) => message).join("\n")
			).toContain("untrusted");
			expect(snapshot.document.settings).toBeUndefined();
			expect(
				await Bun.file(
					path.join(homeRoot, ".wincode", "project-trust.json")
				).exists()
			).toBe(false);
		} finally {
			if (reloadedPluginRuntime !== runtime.pluginRuntime) {
				await reloadedPluginRuntime.shutdown();
			}
			await runtime.pluginRuntime.shutdown();
		}
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
				projectTrustDir: userDataDir,
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
			{ distributionPlugins: [], projectTrustDir: userDataDir, userDataDir }
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
				projectTrustDir: userDataDir,
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
			{ distributionPlugins: [], projectTrustDir: userDataDir, userDataDir }
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
				projectTrustDir: path.join(directory, "project-trust"),
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

	test("interactive startup prompts once for all protected roots in the workspace", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const workspace = path.join(repository, "nested");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			mkdir(path.join(repository, ".git"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, "wincode.json"), "{}"),
			Bun.write(path.join(workspace, "wincode.json"), "{}"),
		]);

		const promptedRoots: string[] = [];
		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				promptedRoots.push(request.workspace);
				expect(
					request.protectedRoots.map(({ projectRoot }) => projectRoot)
				).toEqual([await realpath(repository), await realpath(workspace)]);
				expect(
					request.protectedRoots.every(
						({ currentSessionStatus }) => currentSessionStatus === "pending"
					)
				).toBe(true);
				return "trust";
			},
			projectTrustDir,
			stdinIsTTY: true,
			workspace,
		});

		expect(promptedRoots).toEqual([await realpath(workspace)]);
		expect(new Set(resolution.trustedProjectRoots)).toEqual(
			new Set([await realpath(repository), await realpath(workspace)])
		);
	});

	test("canceling startup skips project resources for this run without saving a decision", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		await mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, "wincode.json"),
			JSON.stringify({ settings: { projectOnly: true } })
		);

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
				homeRoot,
				projectTrustDir: userDataDir,
				userDataDir,
				promptProjectTrust: async () => "cancel",
			}
		);
		try {
			const snapshot =
				await runtime.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toBeUndefined();
			expect(runtime.configRuntime.trustedProjectRoots).toEqual([]);
			expect(runtime.startupDiagnostics.join("\n")).toContain("untrusted");
			expect(
				await Bun.file(path.join(userDataDir, "project-trust.json")).exists()
			).toBe(false);
		} finally {
			await runtime.pluginRuntime.shutdown();
		}
	});

	test("startup parent trust covers every protected root in the workspace", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const workspace = path.join(repository, "nested");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			mkdir(path.join(repository, ".git"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, "wincode.json"), "{}"),
			Bun.write(path.join(workspace, "wincode.json"), "{}"),
		]);

		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				expect(request.parentDirectory).toBe(await realpath(repository));
				return "trust-parent";
			},
			projectTrustDir,
			stdinIsTTY: true,
			workspace,
		});
		const status = await getProjectTrustStatus({
			projectTrustDir,
			trustedProjectRoots: resolution.trustedProjectRoots,
			workspace,
		});

		expect(new Set(resolution.trustedProjectRoots)).toEqual(
			new Set([await realpath(repository), await realpath(workspace)])
		);
		expect(
			status.protectedRoots.map(({ savedDecision }) => savedDecision)
		).toEqual([
			{
				decision: "trust",
				directory: await realpath(repository),
				inherited: false,
			},
			{
				decision: "trust",
				directory: await realpath(repository),
				inherited: true,
			},
		]);
	});

	test("trusting a parent does not authorize protected roots above that parent", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const parent = path.join(repository, "nested");
		const workspace = path.join(parent, "workspace");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			mkdir(path.join(repository, ".git"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await Promise.all(
			[repository, parent, workspace].map((root) =>
				Bun.write(path.join(root, "wincode.json"), "{}")
			)
		);

		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				expect(request.parentDirectory).toBe(await realpath(parent));
				return "trust-parent";
			},
			projectTrustDir,
			stdinIsTTY: true,
			workspace,
		});

		expect(new Set(resolution.trustedProjectRoots)).toEqual(
			new Set([await realpath(parent), await realpath(workspace)])
		);
	});

	test("trust status preserves mixed saved and current-session states per root", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const workspace = path.join(repository, "nested");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			mkdir(path.join(repository, ".git"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(projectTrustDir, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, "wincode.json"), "{}"),
			Bun.write(path.join(workspace, "wincode.json"), "{}"),
			Bun.write(
				path.join(projectTrustDir, "project-trust.json"),
				JSON.stringify({
					version: 1,
					decisions: [
						{ directory: await realpath(repository), decision: "trust" },
						{ directory: await realpath(workspace), decision: "deny" },
					],
				})
			),
		]);

		const status = await getProjectTrustStatus({
			projectTrustDir,
			trustedProjectRoots: [await realpath(repository)],
			workspace,
		});

		expect(status.currentSessionTrusted).toBe(false);
		expect(status.protectedRoots).toEqual([
			{
				currentSessionStatus: "trusted",
				projectRoot: await realpath(repository),
				savedDecision: {
					decision: "trust",
					directory: await realpath(repository),
					inherited: false,
				},
			},
			{
				currentSessionStatus: "untrusted",
				projectRoot: await realpath(workspace),
				savedDecision: {
					decision: "deny",
					directory: await realpath(workspace),
					inherited: false,
				},
			},
		]);
	});

	test("non-interactive modes never infer project trust or prompt even on a TTY", async () => {
		const directory = await createDirectory();
		let promptCount = 0;
		for (const mode of ["print", "json", "rpc", "sdk"] as const) {
			const workspace = path.join(directory, mode);
			await mkdir(workspace, { recursive: true });
			await Bun.write(path.join(workspace, "wincode.json"), "{}");
			const resolution = await resolveProjectTrust({
				mode,
				prompt: async () => {
					promptCount += 1;
					return "trust";
				},
				projectTrustDir: path.join(directory, "user-wincode"),
				stdinIsTTY: true,
				workspace,
			});
			expect(resolution.trustedProjectRoots).toEqual([]);
		}
		expect(promptCount).toBe(0);
	});
});
