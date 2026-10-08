import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentIdSchema, createAgentRuntime } from "@wincode/agent-core";
import type {
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import {
	type OneShotCompositionInput,
	type OneShotDependencies,
	runJsonMode,
	runPrintMode,
} from "@/modules/application/modes/one-shot";
import type {
	ApplicationContext,
	TextWriter,
} from "@/modules/application/modes/types";
import { runRpc } from "@/modules/application/rpc/runner";
import { loadPlugins } from "@/modules/plugins/loader";
import { createSessionCapabilities } from "@/modules/sessions/host/session-capabilities";
import { createConfigStore } from "@/shared/config/config-store";
import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	type FakeModelStepScript,
} from "../support/e2e-fake-runtime";
import { toolCallId } from "../support/identifiers";

const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugins-"));
const homeRoot = path.join(root, "home");
const configRoot = path.join(root, "config");
const installedRoot = path.join(root, "installed");
const workspace = path.join(installedRoot, "workspace");
const pluginPath = path.join(workspace, "plugins", "jira.ts");

await Promise.all([
	mkdir(path.dirname(pluginPath), { recursive: true }),
	mkdir(path.join(installedRoot, "node_modules", "@wincode"), {
		recursive: true,
	}),
]);
await symlink(
	path.resolve(import.meta.dir, "../../..", "..", "packages/coding-agent"),
	path.join(installedRoot, "node_modules", "@wincode", "coding-agent"),
	"dir"
);
await symlink(
	path.dirname(Bun.resolveSync("zod", import.meta.dir)),
	path.join(installedRoot, "node_modules", "zod"),
	"dir"
);
const jiraPluginSource = await Bun.file(
	path.join(import.meta.dir, "../fixtures/jira-plugin.ts")
).text();
await Bun.write(pluginPath, jiraPluginSource);
await Bun.write(
	path.join(workspace, "wincode.json"),
	JSON.stringify({ plugins: ["./plugins/jira.ts"] })
);
await Bun.write(path.join(configRoot, "wincode.json"), "{}");

const configRuntime = {
	configStore: createConfigStore({
		configRoot,
		homeRoot,
		trustedProjectRoots: [],
	}),
	cwd: workspace,
	homeRoot,
	workspace,
};

const createConfigRuntime = (
	workspaceRoot: string,
	userConfigRoot: string
) => ({
	configStore: createConfigStore({
		configRoot: userConfigRoot,
		homeRoot,
		trustedProjectRoots: [],
	}),
	cwd: workspaceRoot,
	homeRoot,
	workspace: workspaceRoot,
});

const commandPluginSource = (
	pluginId: string,
	commandName: string,
	result: string
): string => `
export default async (api) => {
	const plugin = api.definePlugin({ id: ${JSON.stringify(pluginId)} });
	plugin.registerCommand({
		description: "Plugin fixture command.",
		handler: async () => ${JSON.stringify(result)},
		name: ${JSON.stringify(commandName)},
	});
};
`;

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

test("rejects JavaScript paths before evaluating them as Plugins", async () => {
	const javascriptPath = path.join(workspace, "plugins", "not-typescript.js");
	await Bun.write(javascriptPath, 'throw new Error("JavaScript Plugin ran");');

	const runtime = await loadPlugins({
		cliPaths: ["plugins/not-typescript.js"],
		config: configRuntime,
	});

	expect(runtime.getToolDescriptors("session-a")).toEqual([]);
	expect(runtime.getCommands()).toEqual([]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("TypeScript file"),
				sourcePath: javascriptPath,
			}),
		])
	);
	await runtime.shutdown();
});

test("file Plugins expose generic resources to host UI integrations", async () => {
	const resourcePath = path.join(workspace, "plugins", "resource.ts");
	await Bun.write(
		resourcePath,
		`export default async (api) => {
			const plugin = api.definePlugin({ id: "resource_fixture" });
			plugin.registerResource("service", { state: "ready" });
		};`
	);
	const runtime = await loadPlugins({
		cliPaths: [resourcePath],
		config: configRuntime,
	});

	expect(
		runtime.getResource<{ state: string }>("resource_fixture", "service")
	).toEqual({
		state: "ready",
	});
	await runtime.shutdown();
});

test("failed Plugin initialization releases factory-owned resources", async () => {
	let shutdownCount = 0;
	const runtime = await loadPlugins({
		bundledPlugins: [
			{
				id: "failed_resource",
				factory: async (api) => {
					const plugin = api.definePlugin({ id: "failed_resource" });
					plugin.registerResource("service", { state: "initializing" });
					plugin.onShutdown(() => {
						shutdownCount += 1;
					});
					throw new Error("initialization failed");
				},
			},
		],
		cliPaths: [],
		config: configRuntime,
	});

	expect(shutdownCount).toBe(1);
	expect(runtime.getResource("failed_resource", "service")).toBeUndefined();
	await runtime.shutdown();
});

test("required distribution failure shuts down already-loaded Plugins", async () => {
	let shutdownCount = 0;
	const loading = loadPlugins({
		bundledPlugins: [
			{
				id: "loaded_before_missing_distribution",
				factory: (api) => {
					const plugin = api.definePlugin({
						id: "loaded_before_missing_distribution",
					});
					plugin.onShutdown(() => {
						shutdownCount += 1;
					});
				},
			},
		],
		cliPaths: [],
		config: configRuntime,
		distributionPlugins: [
			{
				id: "missing_required",
				specifier: "@wincode/__missing_required_plugin_fixture__",
			},
		],
	});

	await expect(loading).rejects.toThrow(
		"Required distributed Plugin 'missing_required'"
	);
	expect(shutdownCount).toBe(1);
});

test("required distribution identity mismatch cleans up the unpublishable Plugin draft", async () => {
	const cleanupMarker = path.join(workspace, "mismatched-plugin-cleanup");
	await rm(cleanupMarker, { force: true });
	const loading = loadPlugins({
		cliPaths: [],
		config: configRuntime,
		distributionPlugins: [
			{
				id: "expected_distribution_id",
				specifier: path.resolve(
					import.meta.dir,
					"../fixtures/mismatched-distribution-plugin.ts"
				),
			},
		],
	});

	await expect(loading).rejects.toThrow("actual_distribution_id");
	expect(await Bun.file(cleanupMarker).text()).toBe("closed");
});

test("disabled default Plugins are skipped before loading without vetoing file paths", async () => {
	const disabledWorkspace = path.join(
		installedRoot,
		"disabled-plugin-workspace"
	);
	const disabledConfigRoot = path.join(root, "disabled-plugin-config");
	const pluginDirectory = path.join(disabledWorkspace, "plugins");
	const configuredPluginPath = path.join(pluginDirectory, "jira.ts");
	await mkdir(pluginDirectory, { recursive: true });
	await mkdir(disabledConfigRoot, { recursive: true });
	await Bun.write(
		configuredPluginPath,
		commandPluginSource("jira", "explicit_file_plugin", "File Plugin loaded.")
	);
	await Bun.write(
		path.join(disabledConfigRoot, "wincode.json"),
		JSON.stringify({ disabledPlugins: ["jira", "disabled_factory"] })
	);

	let disabledFactoryCalled = false;
	const runtime = await loadPlugins({
		bundledPlugins: [
			{
				id: "disabled_factory",
				factory: async (api) => {
					disabledFactoryCalled = true;
					api.definePlugin({ id: "disabled_factory" });
				},
			},
		],
		cliPaths: [configuredPluginPath],
		config: createConfigRuntime(disabledWorkspace, disabledConfigRoot),
		distributionPlugins: [
			{
				id: "jira",
				specifier: "@wincode/__must_not_resolve_disabled_distribution__",
			},
		],
	});

	expect(disabledFactoryCalled).toBe(false);
	expect(runtime.getCommands()).toMatchObject([
		{ name: "explicit_file_plugin", pluginId: "jira" },
	]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message:
					"Default Plugin 'disabled_factory' was explicitly disabled before loading.",
			}),
			expect.objectContaining({
				message:
					"Default Plugin 'jira' was explicitly disabled before loading.",
			}),
		])
	);
	await runtime.shutdown();
});

test("trusted project configuration loads its explicitly selected Plugin", async () => {
	const trustedConfigRuntime = {
		configStore: createConfigStore({
			configRoot,
			homeRoot,
			trustedProjectRoots: [workspace],
		}),
		cwd: workspace,
		homeRoot,
		workspace,
	};
	const runtime = await loadPlugins({
		cliPaths: [],
		config: trustedConfigRuntime,
	});

	expect(
		runtime.getToolDescriptors("session-a").map(({ name }) => name)
	).toEqual(["plugin_jira_search_issues"]);
	expect(runtime.getCommands().map(({ name }) => name)).toEqual(["open-issue"]);
	expect(runtime.diagnostics).toEqual([]);
	await runtime.shutdown();
});

test("loads an explicitly enabled Plugin and continues after a missing path", async () => {
	const runtime = await loadPlugins({
		cliPaths: ["plugins/missing.ts", "plugins/jira.ts"],
		config: configRuntime,
	});

	expect(
		runtime.getToolDescriptors("session-a").map(({ name }) => name)
	).toEqual(["plugin_jira_search_issues"]);
	expect(runtime.getCommands().map(({ name }) => name)).toEqual(["open-issue"]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("Could not load Plugin"),
				sourcePath: path.join(workspace, "plugins/missing.ts"),
			}),
		])
	);
	await runtime.shutdown();
});

test("CLI Plugin paths win when a configured path declares the same stable identifier", async () => {
	const precedenceWorkspace = path.join(installedRoot, "precedence-workspace");
	const pluginsDirectory = path.join(precedenceWorkspace, "plugins");
	const cliPath = path.join(pluginsDirectory, "explicit.ts");
	const configuredPath = path.join(pluginsDirectory, "configured.ts");
	const precedenceConfigRoot = path.join(root, "precedence-config");
	await mkdir(pluginsDirectory, { recursive: true });
	await mkdir(precedenceConfigRoot, { recursive: true });
	await Bun.write(
		cliPath,
		commandPluginSource("stable_jira", "cli_action", "CLI Plugin won.")
	);
	await Bun.write(
		configuredPath,
		commandPluginSource(
			"stable_jira",
			"configured_action",
			"Configured Plugin lost."
		)
	);
	await Bun.write(
		path.join(precedenceConfigRoot, "wincode.json"),
		JSON.stringify({ plugins: [configuredPath] })
	);

	const runtime = await loadPlugins({
		cliPaths: [path.relative(precedenceWorkspace, cliPath)],
		config: createConfigRuntime(precedenceWorkspace, precedenceConfigRoot),
	});

	expect(runtime.getCommands()).toMatchObject([
		{
			name: "cli_action",
			pluginId: "stable_jira",
			sourcePath: cliPath,
		},
	]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("Duplicate Plugin Identifier"),
				sourcePath: configuredPath,
			}),
		])
	);
	await runtime.shutdown();
});

test("user-selected Plugins win Identifier collisions against trusted project Plugins", async () => {
	const precedenceWorkspace = path.join(
		installedRoot,
		"user-project-precedence"
	);
	const projectPlugins = path.join(precedenceWorkspace, "plugins");
	const userPlugins = path.join(root, "user-selected-plugins");
	const userConfigRoot = path.join(root, "user-project-precedence-config");
	const userPath = path.join(userPlugins, "user.ts");
	const projectPath = path.join(projectPlugins, "project.ts");
	await Promise.all([
		mkdir(projectPlugins, { recursive: true }),
		mkdir(userPlugins, { recursive: true }),
		mkdir(userConfigRoot, { recursive: true }),
	]);
	await Promise.all([
		Bun.write(
			userPath,
			commandPluginSource("same_id", "user_won", "User won.")
		),
		Bun.write(
			projectPath,
			commandPluginSource("same_id", "project_lost", "Project lost.")
		),
		Bun.write(
			path.join(userConfigRoot, "wincode.json"),
			JSON.stringify({ plugins: [userPath] })
		),
		Bun.write(
			path.join(precedenceWorkspace, "wincode.json"),
			JSON.stringify({ plugins: ["./plugins/project.ts"] })
		),
	]);
	const configRuntime = {
		configStore: createConfigStore({
			configRoot: userConfigRoot,
			homeRoot,
			trustedProjectRoots: [precedenceWorkspace],
		}),
		cwd: precedenceWorkspace,
		homeRoot,
		workspace: precedenceWorkspace,
	};
	const runtime = await loadPlugins({ cliPaths: [], config: configRuntime });

	expect(runtime.getCommands()).toMatchObject([
		{ name: "user_won", pluginId: "same_id", sourcePath: userPath },
	]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("Duplicate Plugin Identifier"),
				sourcePath: projectPath,
			}),
		])
	);
	await runtime.shutdown();
});

test("trusted project settings can disable a distribution Plugin before its package loads", async () => {
	const disabledWorkspace = path.join(
		installedRoot,
		"project-disabled-distribution"
	);
	const configRootPath = path.join(root, "project-disabled-config");
	await Promise.all([
		mkdir(disabledWorkspace, { recursive: true }),
		mkdir(configRootPath, { recursive: true }),
	]);
	await Promise.all([
		Bun.write(
			path.join(disabledWorkspace, "wincode.json"),
			JSON.stringify({ disabledPlugins: ["mcp"] })
		),
		Bun.write(path.join(configRootPath, "wincode.json"), JSON.stringify({})),
	]);
	const configRuntime = {
		configStore: createConfigStore({
			configRoot: configRootPath,
			homeRoot,
			trustedProjectRoots: [disabledWorkspace],
		}),
		cwd: disabledWorkspace,
		homeRoot,
		workspace: disabledWorkspace,
	};
	const runtime = await loadPlugins({
		cliPaths: [],
		config: configRuntime,
		distributionPlugins: [
			{
				id: "mcp",
				specifier: "@wincode/__must_not_load_project_disabled_mcp__",
			},
		],
	});

	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: "Default Plugin 'mcp' was explicitly disabled before loading.",
			}),
		])
	);
	await runtime.shutdown();
});

test("a caught registration collision preserves earlier tools and later Plugins still load", async () => {
	const atomicWorkspace = path.join(installedRoot, "atomic-workspace");
	const pluginsDirectory = path.join(atomicWorkspace, "plugins");
	const configRootPath = path.join(root, "atomic-config");
	await mkdir(pluginsDirectory, { recursive: true });
	const healthyPath = path.join(pluginsDirectory, "healthy.ts");
	const collidingPath = path.join(pluginsDirectory, "collision.ts");
	const failedPath = path.join(pluginsDirectory, "failure.ts");
	const laterPath = path.join(pluginsDirectory, "later.ts");
	await Promise.all([
		Bun.write(
			healthyPath,
			commandPluginSource("healthy", "lookup_issue168", "Healthy Plugin.")
		),
		Bun.write(
			collidingPath,
			`import { z } from "zod";
export default (api) => {
	const plugin = api.definePlugin({ id: "colliding" });
	plugin.registerTool({
		description: "Must not leak from an invalid Plugin.",
		handler: () => "leaked",
		inputSchema: z.object({}),
		name: "leaked_tool",
	});
	try {
		plugin.registerCommand({
			description: "Collides with an active command.",
			handler: () => "collision",
			name: "lookup_issue168",
		});
	} catch {
		// The failed call must not discard the earlier valid tool registration.
	}
};`
		),
		Bun.write(
			failedPath,
			`export default async (api) => {
	const plugin = api.definePlugin({ id: "failed" });
	plugin.registerCommand({
		description: "Must not publish after factory failure.",
		handler: () => "failed",
		name: "failed_issue168",
	});
	throw new Error("fixture factory failure");
};`
		),
		Bun.write(
			laterPath,
			commandPluginSource("later", "later_issue168", "Later Plugin.")
		),
	]);

	const runtime = await loadPlugins({
		cliPaths: [
			path.relative(atomicWorkspace, healthyPath),
			path.relative(atomicWorkspace, collidingPath),
			path.relative(atomicWorkspace, failedPath),
			path.relative(atomicWorkspace, laterPath),
		],
		config: createConfigRuntime(atomicWorkspace, configRootPath),
	});

	expect(runtime.getCommands().map(({ name }) => name)).toEqual([
		"lookup_issue168",
		"later_issue168",
	]);
	expect(runtime.getToolDescriptors("session")).toMatchObject([
		expect.objectContaining({
			name: "plugin_colliding_leaked_tool",
		}),
	]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("collides with an active command"),
				sourcePath: collidingPath,
			}),
			expect.objectContaining({
				message: expect.stringContaining("Plugin factory failed"),
				sourcePath: failedPath,
			}),
		])
	);
	await runtime.shutdown();
});

test("built-in and Custom Command names win over colliding Plugin Commands", async () => {
	const collisionWorkspace = path.join(
		installedRoot,
		"command-collision-workspace"
	);
	const pluginsDirectory = path.join(collisionWorkspace, "plugins");
	const customCommandsDirectory = path.join(
		collisionWorkspace,
		".wincode",
		"commands"
	);
	const configRootPath = path.join(root, "command-collision-config");
	await Promise.all([
		mkdir(pluginsDirectory, { recursive: true }),
		mkdir(customCommandsDirectory, { recursive: true }),
		mkdir(configRootPath, { recursive: true }),
	]);
	const builtinCollisionPath = path.join(
		pluginsDirectory,
		"builtin-collision.ts"
	);
	const customCollisionPath = path.join(
		pluginsDirectory,
		"custom-collision.ts"
	);
	const acceptedPath = path.join(pluginsDirectory, "accepted.ts");
	await Promise.all([
		Bun.write(
			builtinCollisionPath,
			commandPluginSource(
				"builtin_collision",
				"settings",
				"Must not replace built-in."
			)
		),
		Bun.write(
			customCollisionPath,
			commandPluginSource(
				"custom_collision",
				"reserved_action",
				"Must not replace custom."
			)
		),
		Bun.write(
			acceptedPath,
			commandPluginSource("accepted", "accepted_action", "Accepted Plugin.")
		),
		Bun.write(
			path.join(customCommandsDirectory, "reserved_action.md"),
			"---\ndescription: Existing command\n---\nKeep this command name."
		),
	]);

	const runtime = await loadPlugins({
		cliPaths: [
			path.relative(collisionWorkspace, builtinCollisionPath),
			path.relative(collisionWorkspace, customCollisionPath),
			path.relative(collisionWorkspace, acceptedPath),
		],
		config: createConfigRuntime(collisionWorkspace, configRootPath),
	});

	expect(runtime.getCommands().map(({ name }) => name)).toEqual([
		"accepted_action",
	]);
	expect(runtime.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining("collides with an active command"),
				sourcePath: builtinCollisionPath,
			}),
			expect.objectContaining({
				message: expect.stringContaining(
					"skipped because a custom command uses the same name"
				),
				sourcePath: customCollisionPath,
			}),
		])
	);
	await runtime.shutdown();
});

test("RPC Mode returns Plugin Tool results through JSON-RPC without polluting stdout", async () => {
	const pluginRuntime = await loadPlugins({
		cliPaths: ["plugins/jira.ts"],
		config: configRuntime,
	});
	const recorder = createFakeModelClientRecorder();
	let steps = 0;
	const script: FakeModelStepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		steps += 1;
		const results = request.messages
			.flatMap(({ content }) => content)
			.filter((part) => part.type === "tool-result");
		if (results.length > 0) {
			yield { delta: "Found WCO-12.", type: "text-delta" };
		} else {
			yield {
				input: { query: "WCO-12" },
				toolCallId: toolCallId("rpc-jira-search-call"),
				toolName: "plugin_jira_search_issues",
				type: "tool-call",
			};
		}
		yield {
			type: "finish",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	};
	const modelRuntime = createAgentRuntime({
		modelClient: createFakeModelClient(recorder, script),
	});
	const connections = {
		authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "OpenAI",
				id: "openai" as const,
				methods: ["api-key", "browser"] as const,
			},
		],
	};
	const assembly = await createSessionCapabilities({
		configRuntime,
		connections,
		cwd: workspace,
		databasePath: path.join(workspace, "plugin-rpc.sqlite"),
		pluginRuntime,
		runtimeFactory: () => modelRuntime,
		workspace,
	});
	const initialized = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<void>();
	const stdoutFrames: string[] = [];
	let toolResultReturned = false;
	const stdout = {
		write(text: string): undefined {
			stdoutFrames.push(text);
			const frame = JSON.parse(text) as {
				id?: string;
				method?: string;
				params?: { state?: { status?: string } };
			};
			if (frame.id === "initialize") {
				initialized.resolve();
			}
			if (
				steps > 1 &&
				frame.method === "session/stateChanged" &&
				frame.params?.state?.status === "idle"
			) {
				toolResultReturned = true;
				completed.resolve();
			}
			return;
		},
	};
	let stderrText = "";
	const stderr = {
		write(text: string): undefined {
			stderrText += text;
			return;
		},
	};
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "plugin-rpc-test" },
				cwd: workspace,
				protocolVersion: 4,
			})}\n`
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: { text: "Search Jira for WCO-12." },
				selection: {
					agentId: "build",
					model: { modelId: "gpt-5.6-luna", providerId: "openai" },
				},
			})}\n`
		);
		await completed.promise;
		yield new TextEncoder().encode(
			`${request("shutdown", "server/shutdown", {})}\n`
		);
	})();

	try {
		const exitCode = await runRpc({
			composeCapabilities: async () => assembly,
			configRuntime,
			input,
			pluginRuntime,
			stderr,
			stdout,
		});

		expect(exitCode).toBe(0);
		expect(toolResultReturned).toBe(true);
		expect(stderrText).toBe("");
		expect(stdoutFrames.join("")).toContain('"query":"WCO-12"');
		expect(stdoutFrames.join("")).toContain("Found WCO-12.");
	} finally {
		await assembly.shutdown();
		await pluginRuntime.shutdown();
	}
});

const captureText = (): { text: string; writer: TextWriter } => {
	let text = "";
	return {
		get text() {
			return text;
		},
		writer: {
			write: (chunk: string) => {
				text += chunk;
			},
		},
	};
};

const runPluginToolInOneShot = async (
	format: "json" | "print",
	pluginRuntime: NonNullable<ApplicationContext["pluginRuntime"]>
) => {
	const recorder = createFakeModelClientRecorder();
	const visibleTools: string[][] = [];
	const mappedToolResults: string[] = [];
	let steps = 0;
	const script: FakeModelStepScript = async function* (
		request: ModelStepRequest
	): AsyncGenerator<ModelStreamPart> {
		steps += 1;
		visibleTools.push((request.tools ?? []).map(({ name }) => name));
		const results = request.messages
			.flatMap(({ content }) => content)
			.filter((part) => part.type === "tool-result");
		if (results.length > 0) {
			mappedToolResults.push(JSON.stringify(results));
			yield { delta: "Found WCO-12.", type: "text-delta" };
		} else {
			yield {
				input: { query: "WCO-12" },
				toolCallId: toolCallId("jira-search-call"),
				toolName: "plugin_jira_search_issues",
				type: "tool-call",
			};
		}
		yield {
			type: "finish",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	};
	const runtime = createAgentRuntime({
		modelClient: createFakeModelClient(recorder, script),
	});
	const connections = {
		authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "OpenAI",
				id: "openai" as const,
				methods: ["api-key", "browser"] as const,
			},
		],
	};
	const composeCapabilities: OneShotDependencies["composeCapabilities"] =
		async ({
			configRuntime: modeConfigRuntime,
			cwd,
			pluginRuntime: modePluginRuntime,
			workspace: modeWorkspace,
		}: OneShotCompositionInput) => ({
			assembly: await createSessionCapabilities({
				configRuntime: modeConfigRuntime,
				cwd,
				databasePath: path.join(modeWorkspace, "sessions.sqlite"),
				runtimeFactory: () => runtime,
				pluginRuntime: modePluginRuntime,
				workspace: modeWorkspace,
				connections,
			}),
		});
	const stdout = captureText();
	const stderr = captureText();
	const context: ApplicationContext = {
		args: ["--plugin", "plugins/jira.ts"],
		configRuntime,
		cwd: workspace,
		invocation: {
			mode: format,
			prompt: "Search Jira for WCO-12.",
		},
		stderr: stderr.writer,
		stdin: (async function* (): AsyncGenerator<Uint8Array> {
			yield* [];
		})(),
		stdinIsTTY: true,
		stdout: stdout.writer,
		pluginRuntime,
	};

	const exitCode =
		format === "json"
			? await runJsonMode(context, { composeCapabilities })
			: await runPrintMode(context, { composeCapabilities });
	return {
		exitCode,
		mappedToolResults,
		stderr: stderr.text,
		stdout: stdout.text,
		steps,
		visibleTools,
	};
};

test("Print Mode calls a selected Plugin Tool and maps its JSON result", async () => {
	const pluginRuntime = await loadPlugins({
		cliPaths: ["plugins/jira.ts"],
		config: configRuntime,
	});
	try {
		const result = await runPluginToolInOneShot("print", pluginRuntime);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Found WCO-12.");
		expect(result.stderr).toBe("");
		expect(result.visibleTools[0]).toContain("plugin_jira_search_issues");
		expect(result.mappedToolResults[0]).toContain(
			'"output":{"query":"WCO-12"}'
		);
		expect(result.steps).toBe(2);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("JSON Mode streams Plugin Tool outcomes as machine-readable events", async () => {
	const pluginRuntime = await loadPlugins({
		cliPaths: ["plugins/jira.ts"],
		config: configRuntime,
	});
	try {
		const result = await runPluginToolInOneShot("json", pluginRuntime);
		const events = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const serializedEvents = events
			.map((event) => JSON.stringify(event))
			.join("\n");

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(serializedEvents).toContain("plugin_jira_search_issues");
		expect(serializedEvents).toContain("Found WCO-12.");
		expect(result.visibleTools[0]).toContain("plugin_jira_search_issues");
		expect(result.mappedToolResults[0]).toContain(
			'"output":{"query":"WCO-12"}'
		);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("file Plugins can request direct names but cannot claim a native tool name", async () => {
	const pluginPathWithCustomName = path.resolve(
		import.meta.dir,
		"../fixtures/namespaced-tool-plugin.ts"
	);
	const runtime = await loadPlugins({
		cliPaths: [path.relative(workspace, pluginPathWithCustomName)],
		config: createConfigRuntime(workspace, configRoot),
	});
	try {
		await runtime.startSession({
			sessionId: "namespace-escape-session",
			workspace,
		});
		expect(
			runtime
				.getToolDescriptors("namespace-escape-session")
				.map(({ name }) => name)
		).toEqual(["jira_search_issues"]);
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining("owned by another capability"),
					sourcePath: pluginPathWithCustomName,
				}),
			])
		);
	} finally {
		await runtime.shutdown();
	}
});

test("duplicate model-visible names within one Plugin fail before tools are published", async () => {
	const duplicateNamePath = path.resolve(
		import.meta.dir,
		"../fixtures/duplicate-model-name-plugin.ts"
	);
	const runtime = await loadPlugins({
		cliPaths: [path.relative(workspace, duplicateNamePath)],
		config: configRuntime,
	});
	try {
		await runtime.startSession({
			sessionId: "duplicate-model-name-session",
			workspace,
		});
		expect(runtime.getToolDescriptors("duplicate-model-name-session")).toEqual(
			[]
		);
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining(
						"model-visible name 'shared_model_name' is registered more than once"
					),
					sourcePath: duplicateNamePath,
				}),
			])
		);
	} finally {
		await runtime.shutdown();
	}
});

test("a rejected later registration preserves prior tools and reports a diagnostic", async () => {
	const pluginPathWithLateFailure = path.resolve(
		import.meta.dir,
		"../fixtures/late-registration-plugin.ts"
	);
	const runtime = await loadPlugins({
		cliPaths: [path.relative(workspace, pluginPathWithLateFailure)],
		config: createConfigRuntime(workspace, configRoot),
	});
	try {
		expect(
			runtime
				.getToolDescriptors("late-registration-session")
				.map(({ name }) => name)
		).toEqual(["plugin_late_registration_valid_tool"]);
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining("Plugin Tool registration failed"),
					sourcePath: pluginPathWithLateFailure,
				}),
			])
		);
	} finally {
		await runtime.shutdown();
	}
});

test("Turn-scoped Plugin registrations override, mask, and preserve outer tools by scope", async () => {
	const scopedPath = path.resolve(
		import.meta.dir,
		"../fixtures/scoped-plugin.ts"
	);
	const runtime = await loadPlugins({
		cliPaths: [path.relative(workspace, scopedPath)],
		config: createConfigRuntime(workspace, configRoot),
	});
	const sessionContext = { sessionId: "scope-session", workspace };
	const turnContext = {
		...sessionContext,
		agentId: agentIdSchema.parse("build"),
		signal: new AbortController().signal,
	};

	try {
		await runtime.startSession(sessionContext);
		const first = await runtime.resolveToolsForTurn(turnContext);
		const firstTool = first[0];
		const second = await runtime.resolveToolsForTurn(turnContext);
		const third = await runtime.resolveToolsForTurn(turnContext);
		const callContext = {
			agentId: agentIdSchema.parse("build"),
			sessionId: sessionContext.sessionId,
			signal: new AbortController().signal,
			toolCallId: toolCallId("scope-tool-call"),
			registerBackgroundWork: () => undefined,
			workspace,
		};

		expect(
			runtime.diagnostics.filter(({ sourcePath }) => sourcePath === scopedPath)
		).toEqual([]);
		expect(first.map(({ name, description }) => [name, description])).toEqual([
			["plugin_scoped_lookup", "Turn version."],
		]);
		expect(firstTool?.description).toBe("Turn version.");
		expect(second).toEqual([]);
		expect(third[0]?.description).toBe("Session version.");
		expect(firstTool?.handler).toBeDefined();
		expect(await firstTool?.handler({}, callContext)).toMatchObject({
			output: "turn",
			type: "success",
		});
		expect(await third[0]?.handler({}, callContext)).toMatchObject({
			output: "session",
			type: "success",
		});
	} finally {
		await runtime.shutdown();
	}
});

test("a failed pre-Agent-Turn hook omits only that Plugin's tools", async () => {
	const failingPath = path.resolve(
		import.meta.dir,
		"../fixtures/failing-pre-turn-plugin.ts"
	);
	const healthyPath = path.resolve(
		import.meta.dir,
		"../fixtures/healthy-pre-turn-plugin.ts"
	);
	const runtime = await loadPlugins({
		cliPaths: [
			path.relative(workspace, failingPath),
			path.relative(workspace, healthyPath),
		],
		config: createConfigRuntime(workspace, configRoot),
	});
	const session = { sessionId: "isolated-turn-session", workspace };

	try {
		await runtime.startSession(session);
		const tools = await runtime.resolveToolsForTurn({
			...session,
			agentId: agentIdSchema.parse("build"),
			signal: new AbortController().signal,
		});

		expect(tools.map(({ name }) => name)).toEqual([
			"plugin_healthy_pre_turn_lookup",
		]);
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining("failed; its tools were omitted"),
					sourcePath: failingPath,
				}),
			])
		);
	} finally {
		await runtime.shutdown();
	}
});

test("Plugins publish status panels and route panel actions through the runtime", async () => {
	let refreshCount = 0;
	const actions: string[] = [];
	const runtime = await loadPlugins({
		bundledPlugins: [
			{
				id: "status_fixture",
				factory: async (api) => {
					const plugin = api.definePlugin({ id: "status_fixture" });
					plugin.registerStatusPanel({
						getSnapshot: () => ({
							items: [
								{
									actions: [
										{ id: "restart", label: "Restart", shortcut: "space" },
									],
									id: "worker",
									label: "Worker",
									status: "warning",
								},
							],
							status: "warning",
							summary: "Needs attention",
						}),
						id: "services",
						indicatorLabel: "Services",
						refresh: async () => {
							refreshCount += 1;
						},
						runAction: async (itemId, actionId) => {
							actions.push(`${itemId}:${actionId}`);
						},
						subscribe: () => () => undefined,
						title: "Services",
					});
					plugin.registerCommand({
						description: "Open the service status panel.",
						name: "services",
						statusPanelId: "services",
					});
				},
			},
		],
		cliPaths: [],
		config: configRuntime,
	});
	try {
		expect(runtime.getStatusPanels()).toMatchObject([
			{
				id: "services",
				indicatorLabel: "Services",
				pluginId: "status_fixture",
				title: "Services",
			},
		]);
		expect(runtime.getCommands()).toContainEqual(
			expect.objectContaining({
				name: "services",
				pluginId: "status_fixture",
				statusPanelId: "services",
			})
		);
		await runtime.refreshStatusPanel("status_fixture", "services");
		await runtime.runStatusPanelAction(
			"status_fixture",
			"services",
			"worker",
			"restart"
		);
		expect({ actions, refreshCount }).toEqual({
			actions: ["worker:restart"],
			refreshCount: 1,
		});
	} finally {
		await runtime.shutdown();
	}
});
