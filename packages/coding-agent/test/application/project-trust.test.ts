import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
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
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-project-trust-")
	);
	temporaryDirectories.push(directory);
	return directory;
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { force: true, recursive: true }))
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
			fs.mkdir(builtinRoot, { recursive: true }),
			fs.mkdir(path.dirname(agentPath), { recursive: true }),
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
		expect(untrusted.untrustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);
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
		expect(trusted.trustedProjectRoots).toContain(await fs.realpath(workspace));
		expect(
			trustedAgents.agents.some(({ agent }) => agent.id === "project-only")
		).toBe(true);
	});

	test("print startup skips untrusted project config before evaluating its Plugin", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(homeRoot, ".local", "share", "wincode");
		const marker = path.join(directory, "plugin-evaluated");
		await Promise.all([fs.mkdir(workspace, { recursive: true })]);
		await Promise.all([
			Bun.write(
				path.join(homeRoot, ".wincode", "settings.json"),
				JSON.stringify({ settings: { userOnly: true } })
			),
			Bun.write(
				path.join(homeRoot, ".wincode", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						user_server: {
							command: "bun",
							args: ["run", "user-server.ts"],
						},
					},
				})
			),
			Bun.write(
				path.join(workspace, ".wincode", "settings.json"),
				JSON.stringify({
					plugins: ["./project-plugin.ts"],
					settings: { projectOnly: true },
				})
			),
			Bun.write(
				path.join(workspace, ".wincode", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						project_server: {
							command: "bun",
							args: ["run", "project-server.ts"],
						},
					},
				})
			),
		]);
		await Bun.write(
			path.join(workspace, "project-plugin.ts"),
			`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "evaluated");\nexport default (api: { definePlugin(input: { id: string }): void }) => api.definePlugin({ id: "project_plugin" });\n`
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
				distributionPlugins: [],
				homeRoot,
				userDataDir,
			}
		);
		try {
			const [settingsSnapshot, mcpSnapshot] = await Promise.all([
				runtime.configRuntime.configStore.getSnapshot(workspace),
				runtime.configRuntime.configStore.getNamespaceSnapshot(
					workspace,
					"mcp"
				),
			]);
			const mcp = await resolveMcpConfig({
				env: {},
				snapshot: mcpSnapshot,
				workspace,
			});
			expect(Object.keys(mcp.servers)).toEqual(["user_server"]);
			expect(settingsSnapshot.document.settings).toEqual({ userOnly: true });
			expect(
				runtime.pluginRuntime.getToolDescriptors("project-trust-test")
			).toEqual([]);
			expect(await Bun.file(marker).exists()).toBe(false);
			expect(runtime.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
		} finally {
			await runtime.pluginRuntime?.shutdown();
		}
	});

	test("project Plugin and MCP processes stay unloaded before trust and after refusal", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const pluginMarker = path.join(directory, "plugin-evaluated");
		const serverMarker = path.join(directory, "mcp-started");
		await Promise.all([fs.mkdir(workspace, { recursive: true })]);
		await Promise.all([
			Bun.write(
				path.join(workspace, ".wincode", "settings.json"),
				JSON.stringify({ plugins: ["./project-plugin.ts"] })
			),
			Bun.write(
				path.join(workspace, ".wincode", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						project_server: {
							command: process.execPath,
							args: [
								"-e",
								`await Bun.write(${JSON.stringify(serverMarker)}, "started");`,
							],
						},
					},
				})
			),
			Bun.write(
				path.join(workspace, "project-plugin.ts"),
				`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pluginMarker)}, "evaluated");\nexport default (api: { definePlugin(input: { id: string }): void }) => api.definePlugin({ id: "project_plugin" });\n`
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
		await fs.mkdir(path.join(configDirectory, "plugins"), { recursive: true });
		await Promise.all([
			Bun.write(
				path.join(configDirectory, "settings.json"),
				JSON.stringify({ plugins: ["./plugins/project-plugin.ts"] })
			),
			Bun.write(
				path.join(configDirectory, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						project_server: {
							command: "bun",
							args: ["run", "project-server.ts"],
						},
					},
				})
			),
		]);
		await Bun.write(
			path.join(configDirectory, "plugins", "project-plugin.ts"),
			`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "evaluated");\nexport default (api) => { const plugin = api.definePlugin({ id: "project_plugin" }); plugin.registerResource("loaded", true); };\n`
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
				await runtime.configRuntime.configStore.getNamespaceSnapshot(
					workspace,
					"mcp"
				);
			const mcp = await resolveMcpConfig({ env: {}, snapshot, workspace });
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
		await fs.mkdir(workspace, { recursive: true });
		const configPath = path.join(workspace, ".wincode/settings.json");
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
					expect(request.workspace).toBe(await fs.realpath(workspace));
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

	test("session-only trust decisions apply to the run without writing a trust file", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		const trustFilePath = path.join(homeRoot, ".wincode", "project-trust.json");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, ".wincode", "settings.json"),
			JSON.stringify({ settings: { sessionOnly: true } })
		);
		let prompts = 0;
		const trusted = await initializeApplicationRuntime(
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
					return "trust-session";
				},
			}
		);
		try {
			const snapshot =
				await trusted.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toEqual({ sessionOnly: true });
			expect(trusted.sessionTrustDecision).toBe("trust");
			expect(trusted.configRuntime.untrustedProjectRoots).toEqual([]);
		} finally {
			await trusted.pluginRuntime.shutdown();
		}
		expect(await Bun.file(trustFilePath).exists()).toBe(false);

		const denied = await initializeApplicationRuntime(
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
					return "deny-session";
				},
			}
		);
		try {
			expect(prompts).toBe(2);
			expect(denied.sessionTrustDecision).toBe("deny");
			expect(denied.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
			expect(denied.startupDiagnostics).toEqual([]);
			const snapshot =
				await denied.configRuntime.configStore.getSnapshot(workspace);
			expect(snapshot.document.settings).toBeUndefined();
		} finally {
			await denied.pluginRuntime.shutdown();
		}
		expect(await Bun.file(trustFilePath).exists()).toBe(false);
	});

	test("persisted Project trust changes take effect only after a new runtime starts", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		const projectTrustDir = path.join(homeRoot, ".wincode");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, ".wincode", "settings.json"),
			JSON.stringify({ settings: { fromProject: true } })
		);
		const canonicalWorkspace = await fs.realpath(workspace);
		const initializeRuntime = () =>
			initializeApplicationRuntime(
				{
					cwd: workspace,
					disabledPluginIds: [],
					mode: "print",
					pluginPaths: [],
					stdinIsTTY: false,
				},
				{ distributionPlugins: [], homeRoot, userDataDir }
			);

		await saveProjectTrustDecision({
			decision: "deny",
			projectTrustDir,
			workspace,
		});
		const initiallyDenied = await initializeRuntime();
		const pluginRuntimes = new Set([initiallyDenied.pluginRuntime]);
		try {
			expect(initiallyDenied.configRuntime.untrustedProjectRoots).toContain(
				canonicalWorkspace
			);

			await saveProjectTrustDecision({
				decision: "trust",
				projectTrustDir,
				workspace,
			});
			const stillDenied = await initiallyDenied.resourceLoader.reload({
				current: {
					configRuntime: initiallyDenied.configRuntime,
					pluginRuntime: initiallyDenied.pluginRuntime,
				},
			});
			pluginRuntimes.add(stillDenied.pluginRuntime);
			expect(stillDenied.configRuntime.trustedProjectRoots).toEqual([]);
			expect(stillDenied.configRuntime.untrustedProjectRoots).toContain(
				canonicalWorkspace
			);
			expect(
				(await stillDenied.configRuntime.configStore.getSnapshot(workspace))
					.document.settings
			).toBeUndefined();

			const trusted = await initializeRuntime();
			pluginRuntimes.add(trusted.pluginRuntime);
			expect(trusted.configRuntime.trustedProjectRoots).toContain(
				canonicalWorkspace
			);
			expect(
				(await trusted.configRuntime.configStore.getSnapshot(workspace))
					.document.settings
			).toEqual({ fromProject: true });

			await saveProjectTrustDecision({
				decision: "deny",
				projectTrustDir,
				workspace,
			});
			const stillTrusted = await trusted.resourceLoader.reload({
				current: {
					configRuntime: trusted.configRuntime,
					pluginRuntime: trusted.pluginRuntime,
				},
			});
			pluginRuntimes.add(stillTrusted.pluginRuntime);
			expect(stillTrusted.configRuntime.trustedProjectRoots).toContain(
				canonicalWorkspace
			);
			expect(
				(await stillTrusted.configRuntime.configStore.getSnapshot(workspace))
					.document.settings
			).toEqual({ fromProject: true });

			const deniedAfterRestart = await initializeRuntime();
			pluginRuntimes.add(deniedAfterRestart.pluginRuntime);
			expect(deniedAfterRestart.configRuntime.untrustedProjectRoots).toContain(
				canonicalWorkspace
			);
			expect(
				(
					await deniedAfterRestart.configRuntime.configStore.getSnapshot(
						workspace
					)
				).document.settings
			).toBeUndefined();
		} finally {
			for (const pluginRuntime of pluginRuntimes) {
				await pluginRuntime.shutdown();
			}
		}
	});

	test("Resource Reload preserves the startup session-only trust choice", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		const projectTrustDir = path.join(homeRoot, ".wincode");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, ".wincode", "settings.json"),
			JSON.stringify({ settings: { sessionOnly: true } })
		);
		const canonicalWorkspace = await fs.realpath(workspace);
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
				userDataDir,
				promptProjectTrust: async () => "trust-session",
			}
		);
		const pluginRuntimes = new Set([runtime.pluginRuntime]);
		try {
			expect(runtime.sessionTrustDecision).toBe("trust");
			await saveProjectTrustDecision({
				decision: "deny",
				projectTrustDir,
				workspace,
			});

			const reloaded = await runtime.resourceLoader.reload({
				current: {
					configRuntime: runtime.configRuntime,
					pluginRuntime: runtime.pluginRuntime,
				},
			});
			pluginRuntimes.add(reloaded.pluginRuntime);
			expect(reloaded.configRuntime.trustedProjectRoots).toContain(
				canonicalWorkspace
			);
			expect(
				(await reloaded.configRuntime.configStore.getSnapshot(workspace))
					.document.settings
			).toEqual({ sessionOnly: true });
		} finally {
			for (const pluginRuntime of pluginRuntimes) {
				await pluginRuntime.shutdown();
			}
		}
	});

	test("untrusted project Skills are omitted while personal Skills remain available", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		await Promise.all([
			fs.mkdir(path.join(workspace, ".wincode", "skills", "project-skill"), {
				recursive: true,
			}),
			fs.mkdir(path.join(homeRoot, ".wincode", "skills", "personal-skill"), {
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
			expect(runtime.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
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
			fs.mkdir(skillsRoot, { recursive: true }),
			fs.mkdir(commandsRoot, { recursive: true }),
		]);
		await fs.symlink(realWorkspace, workspaceAlias, "dir");
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
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, ".wincode/settings.json"),
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
		expect(refused.configRuntime.untrustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);

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
			expect(savedRefusal.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
		} finally {
			await savedRefusal.pluginRuntime.shutdown();
		}
		expect(prompts).toBe(1);
	});

	test("/trust replaces a saved refusal so the next runtime trusts project resources", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const userDataDir = path.join(directory, "user-data");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, ".wincode/settings.json"), "{}");

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

		expect(resolution.trustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);
		expect(resolution.diagnostics).toEqual([]);
	});

	test("trusting a parent clears a child refusal and reports inherited status", async () => {
		const directory = await createDirectory();
		const parent = path.join(directory, "workspace");
		const workspace = path.join(parent, "repo");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			fs.mkdir(path.join(parent, ".git"), { recursive: true }),
			fs.mkdir(workspace, { recursive: true }),
		]);
		await Bun.write(path.join(workspace, ".wincode/settings.json"), "{}");

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

		expect(resolution.trustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);
		expect(status.currentSessionTrusted).toBe(true);
		expect(status.parentDirectory).toBe(await fs.realpath(parent));
		expect(status.protectedRoots).toEqual([
			{
				currentSessionStatus: "trusted",
				projectRoot: await fs.realpath(workspace),
				savedDecision: {
					decision: "trust",
					directory: await fs.realpath(parent),
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
		await fs.mkdir(workspace, { recursive: true });
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
				userDataDir,
			}
		);
		let reloadedPluginRuntime = runtime.pluginRuntime;
		try {
			expect(runtime.configRuntime.trustedProjectRoots).toEqual([]);
			await Bun.write(
				path.join(workspace, ".wincode/settings.json"),
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
			expect(result.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
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
			fs.mkdir(projectRoot, { recursive: true }),
			fs.mkdir(path.join(descendant, ".git"), { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(projectRoot, ".wincode/settings.json"),
				JSON.stringify({ settings: { ancestor: true } })
			),
			Bun.write(
				path.join(descendant, ".wincode/settings.json"),
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
			fs.mkdir(path.join(projectRoot, ".git"), { recursive: true }),
			fs.mkdir(path.join(descendant, ".git"), { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(projectRoot, ".wincode/settings.json"),
				JSON.stringify({ settings: { ancestor: true } })
			),
			Bun.write(
				path.join(descendant, ".wincode/settings.json"),
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
			expect(ancestor.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(projectRoot)
			);
		} finally {
			await ancestor.pluginRuntime.shutdown();
		}
	});

	test("AGENTS.md alone does not prompt for Project trust", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(path.join(workspace, "AGENTS.md"), "untrusted context");
		await Promise.all([
			fs.mkdir(path.join(workspace, ".wincode", "skills"), { recursive: true }),
			fs.mkdir(path.join(workspace, ".wincode", "commands"), {
				recursive: true,
			}),
			fs.mkdir(path.join(workspace, ".wincode", "plugins"), {
				recursive: true,
			}),
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
			fs.mkdir(path.join(repository, ".git"), { recursive: true }),
			fs.mkdir(workspace, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, ".wincode/settings.json"), "{}"),
			Bun.write(path.join(workspace, ".wincode/settings.json"), "{}"),
		]);

		const promptedRoots: string[] = [];
		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				promptedRoots.push(request.workspace);
				expect(
					request.protectedRoots.map(({ projectRoot }) => projectRoot)
				).toEqual([
					await fs.realpath(repository),
					await fs.realpath(workspace),
				]);
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

		expect(promptedRoots).toEqual([await fs.realpath(workspace)]);
		expect(new Set(resolution.trustedProjectRoots)).toEqual(
			new Set([await fs.realpath(repository), await fs.realpath(workspace)])
		);
	});

	test("canceling startup behaves like session-only deny across reload without saving", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const workspace = path.join(repository, "nested");
		const projectTrustDir = path.join(directory, "user-data");
		const trustFilePath = path.join(projectTrustDir, "project-trust.json");
		await Promise.all([
			fs.mkdir(path.join(repository, ".git"), { recursive: true }),
			fs.mkdir(path.join(workspace, ".wincode"), { recursive: true }),
			fs.mkdir(path.join(repository, ".wincode"), { recursive: true }),
		]);
		await Promise.all([
			Bun.write(
				path.join(repository, ".wincode/settings.json"),
				JSON.stringify({ settings: { repository: true } })
			),
			Bun.write(
				path.join(workspace, ".wincode/settings.json"),
				JSON.stringify({ settings: { projectOnly: true } })
			),
		]);
		const savedTrust = {
			decisions: [
				{ decision: "trust", directory: await fs.realpath(workspace) },
			],
			version: 1,
		};
		await Bun.write(trustFilePath, JSON.stringify(savedTrust));

		const cancelled = await resolveProjectTrust({
			mode: "interactive",
			projectTrustDir,
			prompt: async () => "cancel",
			stdinIsTTY: true,
			workspace,
		});
		expect(cancelled.sessionDecision).toBe("deny");
		expect(cancelled.trustedProjectRoots).toEqual([]);
		expect(cancelled.untrustedProjectRoots).toContain(
			await fs.realpath(repository)
		);
		expect(cancelled.untrustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);

		const reloaded = await resolveProjectTrust({
			mode: "interactive",
			projectTrustDir,
			trustSnapshot: cancelled.trustSnapshot,
			workspace,
		});
		expect(reloaded.sessionDecision).toBe("deny");
		expect(reloaded.trustedProjectRoots).toEqual([]);
		expect(reloaded.untrustedProjectRoots).toContain(
			await fs.realpath(workspace)
		);
		expect(await Bun.file(trustFilePath).json()).toEqual(savedTrust);
	});

	test("canceling startup is a session-only deny without saving a decision", async () => {
		const directory = await createDirectory();
		const workspace = path.join(directory, "repo");
		const homeRoot = path.join(directory, "home");
		const userDataDir = path.join(directory, "user-data");
		await fs.mkdir(workspace, { recursive: true });
		await Bun.write(
			path.join(workspace, ".wincode/settings.json"),
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
			expect(runtime.sessionTrustDecision).toBe("deny");
			expect(runtime.configRuntime.trustedProjectRoots).toEqual([]);
			expect(runtime.configRuntime.untrustedProjectRoots).toContain(
				await fs.realpath(workspace)
			);
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
			fs.mkdir(path.join(repository, ".git"), { recursive: true }),
			fs.mkdir(workspace, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, ".wincode/settings.json"), "{}"),
			Bun.write(path.join(workspace, ".wincode/settings.json"), "{}"),
		]);

		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				expect(request.parentDirectory).toBe(await fs.realpath(repository));
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
			new Set([await fs.realpath(repository), await fs.realpath(workspace)])
		);
		expect(
			status.protectedRoots.map(({ savedDecision }) => savedDecision)
		).toEqual([
			{
				decision: "trust",
				directory: await fs.realpath(repository),
				inherited: false,
			},
			{
				decision: "trust",
				directory: await fs.realpath(repository),
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
			fs.mkdir(path.join(repository, ".git"), { recursive: true }),
			fs.mkdir(workspace, { recursive: true }),
		]);
		await Promise.all(
			[repository, parent, workspace].map((root) =>
				Bun.write(path.join(root, ".wincode/settings.json"), "{}")
			)
		);

		const resolution = await resolveProjectTrust({
			mode: "interactive",
			prompt: async (request) => {
				expect(request.parentDirectory).toBe(await fs.realpath(parent));
				return "trust-parent";
			},
			projectTrustDir,
			stdinIsTTY: true,
			workspace,
		});

		expect(new Set(resolution.trustedProjectRoots)).toEqual(
			new Set([await fs.realpath(parent), await fs.realpath(workspace)])
		);
	});

	test("trust status preserves mixed saved and current-session states per root", async () => {
		const directory = await createDirectory();
		const repository = path.join(directory, "repo");
		const workspace = path.join(repository, "nested");
		const projectTrustDir = path.join(directory, "user-wincode");
		await Promise.all([
			fs.mkdir(path.join(repository, ".git"), { recursive: true }),
			fs.mkdir(workspace, { recursive: true }),
			fs.mkdir(projectTrustDir, { recursive: true }),
		]);
		await Promise.all([
			Bun.write(path.join(repository, ".wincode/settings.json"), "{}"),
			Bun.write(path.join(workspace, ".wincode/settings.json"), "{}"),
			Bun.write(
				path.join(projectTrustDir, "project-trust.json"),
				JSON.stringify({
					version: 1,
					decisions: [
						{ directory: await fs.realpath(repository), decision: "trust" },
						{ directory: await fs.realpath(workspace), decision: "deny" },
					],
				})
			),
		]);

		const status = await getProjectTrustStatus({
			projectTrustDir,
			trustedProjectRoots: [await fs.realpath(repository)],
			workspace,
		});

		expect(status.currentSessionTrusted).toBe(false);
		expect(status.protectedRoots).toEqual([
			{
				currentSessionStatus: "trusted",
				projectRoot: await fs.realpath(repository),
				savedDecision: {
					decision: "trust",
					directory: await fs.realpath(repository),
					inherited: false,
				},
			},
			{
				currentSessionStatus: "untrusted",
				projectRoot: await fs.realpath(workspace),
				savedDecision: {
					decision: "deny",
					directory: await fs.realpath(workspace),
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
			await fs.mkdir(workspace, { recursive: true });
			await Bun.write(path.join(workspace, ".wincode/settings.json"), "{}");
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
