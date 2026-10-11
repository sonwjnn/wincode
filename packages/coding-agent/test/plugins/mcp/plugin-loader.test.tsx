import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { McpClient } from "@wincode/mcp";
import {
	createMcpPluginFactory,
	type McpPluginDependencies,
} from "@wincode/mcp/plugin";
import { act, useEffect } from "react";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { loadPlugins } from "@/modules/plugins/loader";
import type {
	PluginRuntime,
	PluginStatusPanelDescriptor,
} from "@/modules/plugins/runtime";
import { PluginStatusPanelDialogContent } from "@/modules/plugins/ui/plugin-status-panel-dialog";
import { PluginStatusSidebar } from "@/modules/plugins/ui/plugin-status-sidebar";
import { createConfigStore } from "@/shared/config/config-store";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import { agentId, sessionId } from "../../support/identifiers";
import { flushTestRenderer } from "../../support/opentui";

const OpenStatusPanel = ({
	panel,
	runtime,
}: Readonly<{
	panel: PluginStatusPanelDescriptor;
	runtime: PluginRuntime;
}>) => {
	const { open } = useDialog();
	const { push } = useKeyboardLayer();
	useEffect(() => {
		push("dialog");
		open({
			children: (
				<PluginStatusPanelDialogContent panel={panel} pluginRuntime={runtime} />
			),
			title: panel.title,
		});
	}, [open, panel, push, runtime]);
	return null;
};

test("the distributed MCP package renders its contribution in the generic status panel", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-mcp-plugin-"));
	const configDirectory = path.join(root, ".wincode");
	const workspace = path.join(root, "workspace");
	const configPath = path.join(configDirectory, "mcp.json");
	await mkdir(configDirectory, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await Bun.write(
		configPath,
		JSON.stringify({
			mcpServers: {
				offline: {
					enabled: false,
					url: "https://mcp.example.test",
				},
			},
		})
	);

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			cliPaths: [],
			config: {
				configStore: createConfigStore({ homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			distributionPlugins: [{ id: "mcp", specifier: "@wincode/mcp/plugin" }],
		});
		const panel = runtime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
		expect(panel).toBeDefined();
		if (panel === undefined) {
			throw new Error("The distributed MCP Plugin did not register its panel.");
		}
		expect(runtime.getCommands()).toContainEqual(
			expect.objectContaining({ name: "mcps", statusPanelId: "servers" })
		);
		const turnTools = await runtime.resolveToolsForTurn({
			agentId: agentId("mcp-resources"),
			sessionId: sessionId("mcp-resources-session"),
			workspace,
			signal: new AbortController().signal,
		});
		expect(turnTools.map(({ name }) => name)).toContain("mcp_list_resources");
		expect(turnTools.map(({ name }) => name)).toContain(
			"mcp_list_resource_templates"
		);
		expect(turnTools.map(({ name }) => name)).toContain("mcp_read_resource");
		expect(panel.getSnapshot()).toMatchObject({
			items: [
				{
					actions: [
						{ id: "toggle", label: "Enable", shortcut: "space" },
						{ id: "exposure", label: "Hide tools", shortcut: "space" },
					],
					id: "offline",
					label: "offline",
					status: "idle",
					summary: "0 tools • remote • direct • no auth • global",
				},
			],
			status: "idle",
			summary: "0",
		});

		setInteractiveRuntimeContext({
			args: [],
			cwd: workspace,
			pluginRuntime: runtime,
		});
		const setup = await testRender(
			<ThemeProvider>
				<PluginStatusSidebar />
			</ThemeProvider>,
			{ height: 8, width: 80 }
		);
		try {
			await flushTestRenderer(setup);
			const frame = setup.captureCharFrame();
			expect(frame).toContain("MCP Servers");
			expect(frame).toContain("offline");
			expect(frame).toContain("idle");
		} finally {
			setup.renderer.destroy();
		}

		const dialogSetup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ToastProvider>
						<DialogProvider>
							<OpenStatusPanel panel={panel} runtime={runtime} />
						</DialogProvider>
					</ToastProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 18, width: 80 }
		);
		try {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(dialogSetup);
				if (dialogSetup.captureCharFrame().includes("offline")) {
					break;
				}
			}
			const dialogFrame = dialogSetup.captureCharFrame();
			expect(dialogFrame).toContain("MCP Servers");
			expect(dialogFrame).toContain("offline");
			expect(dialogFrame).toContain("Enable");
			expect(dialogFrame).toContain("0 tools • remote");
			expect(dialogFrame).toContain("ctrl+r");

			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: {
						offline: {
							enabled: false,
							url: "https://mcp.example.test",
						},
						refreshed: {
							enabled: false,
							url: "https://new-mcp.example.test",
						},
					},
				})
			);
			await act(async () => {
				dialogSetup.mockInput.pressKey("r", { ctrl: true });
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(dialogSetup);
				if (dialogSetup.captureCharFrame().includes("refreshed")) {
					break;
				}
			}
			expect(dialogSetup.captureCharFrame()).toContain("refreshed");
		} finally {
			dialogSetup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		setInteractiveRuntimeContext({ args: [], cwd: workspace });
		await rm(root, { force: true, recursive: true });
	}
});

test("Plugin-owned MCP Server registrations enter the managed server catalog", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-mcp-server-")
	);
	const workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					id: "extension",
					factory: (api) => {
						const plugin = api.definePlugin({ id: "extension" });
						plugin.registerMcpServer("extension_server", {
							command: "bun",
							args: ["-e", "process.exit(0)"],
							enabled: false,
						});
					},
				},
			],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			distributionPlugins: [{ id: "mcp", specifier: "@wincode/mcp/plugin" }],
		});
		const panel = runtime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
		expect(panel?.getSnapshot().items).toContainEqual(
			expect.objectContaining({
				id: "extension_server",
				label: "extension_server",
				summary: "0 tools • local • direct • no auth • Plugin extension",
			})
		);
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("a custom command takes precedence over a distributed Plugin command", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugin-command-"));
	const workspace = path.join(root, "workspace");
	const customCommands = path.join(workspace, ".wincode", "commands");
	await mkdir(customCommands, { recursive: true });
	await Bun.write(
		path.join(customCommands, "mcps.md"),
		`---
description: Custom MCP shortcut
---
List local resources.
`
	);

	const config = {
		configStore: createConfigStore({ homeRoot: root }),
		cwd: workspace,
		homeRoot: root,
		workspace,
	};
	let runtime: PluginRuntime | undefined;
	try {
		expect(await getCustomCommands(config)).toContainEqual(
			expect.objectContaining({ name: "mcps" })
		);
		runtime = await loadPlugins({
			cliPaths: [],
			config,
			distributionPlugins: [{ id: "mcp", specifier: "@wincode/mcp/plugin" }],
		});

		expect(runtime.getCommands()).not.toContainEqual(
			expect.objectContaining({ name: "mcps" })
		);
		expect(runtime.getStatusPanels()).toContainEqual(
			expect.objectContaining({ id: "servers", pluginId: "mcp" })
		);
		expect(runtime.diagnostics).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining("a custom command uses the same name"),
			})
		);
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("generic Plugin status panels refresh from Ctrl+R", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugin-refresh-"));
	const workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });

	let refreshCount = 0;
	const listeners = new Set<() => void>();
	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					factory: (api) => {
						const plugin = api.definePlugin({ id: "refreshable" });
						plugin.registerStatusPanel({
							getSnapshot: () => ({
								items: [
									{
										id: "service",
										label: "Service",
										status: refreshCount > 0 ? "success" : "idle",
										summary: `refresh count ${refreshCount}`,
									},
								],
							}),
							id: "service",
							refresh: async () => {
								refreshCount += 1;
								for (const listener of listeners) {
									listener();
								}
							},
							runAction: async () => undefined,
							subscribe: (listener) => {
								listeners.add(listener);
								return () => listeners.delete(listener);
							},
							title: "Refreshable",
						});
					},
					id: "refreshable",
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
		});
		const panel = runtime
			.getStatusPanels()
			.find(
				({ id, pluginId }) => id === "service" && pluginId === "refreshable"
			);
		if (panel === undefined) {
			throw new Error(
				"The refreshable Plugin did not register its status panel."
			);
		}
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ToastProvider>
						<DialogProvider>
							<OpenStatusPanel panel={panel} runtime={runtime} />
						</DialogProvider>
					</ToastProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 18, width: 80 }
		);
		try {
			await flushTestRenderer(setup);
			const initialFrame = setup.captureCharFrame();
			expect(initialFrame).toContain("ctrl+r");
			expect(initialFrame).toContain("refresh count 0");

			await act(async () => {
				setup.mockInput.pressKey("r", { ctrl: true });
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (setup.captureCharFrame().includes("refresh count 1")) {
					break;
				}
			}

			expect(refreshCount).toBe(1);
			expect(setup.captureCharFrame()).toContain("refresh count 1");
		} finally {
			setup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("status-panel search retains spaces when the highlighted item has no space action", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugin-spaces-"));
	const workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					factory: (api) => {
						const plugin = api.definePlugin({ id: "searchable" });
						plugin.registerStatusPanel({
							getSnapshot: () => ({
								items: [
									{
										id: "status",
										label: "system ready",
										status: "success",
									},
								],
							}),
							id: "status",
							runAction: async () => undefined,
							subscribe: () => () => undefined,
							title: "Searchable",
						});
					},
					id: "searchable",
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
		});
		const panel = runtime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "status" && pluginId === "searchable");
		if (panel === undefined) {
			throw new Error(
				"The searchable Plugin did not register its status panel."
			);
		}
		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ToastProvider>
						<DialogProvider>
							<OpenStatusPanel panel={panel} runtime={runtime} />
						</DialogProvider>
					</ToastProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 18, width: 80 }
		);
		try {
			await flushTestRenderer(setup);
			await act(async () => {
				await setup.mockInput.typeText("system ready");
			});
			await flushTestRenderer(setup);

			expect(setup.captureCharFrame()).toContain("Ready");
		} finally {
			setup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("the generic MCP panel shows safe failures and routes reconnect and disable actions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-mcp-actions-"));
	const workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });

	let connectionAttempts = 0;
	const failureUrl =
		"https://diagnostics.example.test/path?token=leaked-secret";
	const mcpConfigPath = path.join(root, ".wincode", "mcp.json");
	await Bun.write(
		mcpConfigPath,
		JSON.stringify({
			mcpServers: {
				broken: {
					url: "https://configured.example.test/mcp?token=configured-secret",
					headers: { Authorization: "Bearer configured-secret" },
				},
			},
		})
	);
	const trustedWorkspace = await realpath(workspace);
	const trustedProjectRoots = [trustedWorkspace];
	const configStore = createConfigStore({
		homeRoot: root,
		trustedProjectRoots,
	});
	const configSnapshot = await configStore.getNamespaceSnapshot(
		workspace,
		"mcp"
	);
	expect(configSnapshot.sources.map(({ scope }) => scope)).toEqual([
		"global",
		"project",
	]);
	const dependencies: McpPluginDependencies = {
		createClient: (): McpClient => ({
			callTool: async () => ({ content: [] }),
			close: async () => undefined,
			connect: async () => {
				connectionAttempts += 1;
				if (connectionAttempts === 1) {
					throw new Error(`Connection failed at ${failureUrl}`);
				}
			},
			listTools: async () => [],
			setToolsChangedListener: () => undefined,
		}),
	};

	let runtime: PluginRuntime | undefined;
	try {
		const loadedRuntime = await loadPlugins({
			bundledPlugins: [
				{ factory: createMcpPluginFactory(dependencies), id: "mcp" },
			],
			cliPaths: [],
			config: {
				configStore,
				cwd: workspace,
				homeRoot: root,
				trustedProjectRoots,
				workspace,
			},
			distributionPlugins: [],
		});
		runtime = loadedRuntime;
		const panel = loadedRuntime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
		if (panel === undefined) {
			throw new Error("The MCP Plugin did not register its status panel.");
		}
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (panel.getSnapshot().items[0]?.status === "error") {
				break;
			}
			await Bun.sleep(5);
		}
		const failedItem = panel.getSnapshot().items[0];
		expect(failedItem).toMatchObject({ label: "broken", status: "error" });
		expect(failedItem?.detail).toContain("[redacted]");
		expect(failedItem?.detail).not.toContain("diagnostics.example.test");

		const setup = await testRender(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ToastProvider>
						<DialogProvider>
							<OpenStatusPanel panel={panel} runtime={runtime} />
						</DialogProvider>
					</ToastProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>,
			{ height: 20, width: 100 }
		);
		try {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (setup.captureCharFrame().includes("broken")) {
					break;
				}
			}
			const failedFrame = setup.captureCharFrame();
			expect(failedFrame).toContain("Error");
			expect(failedFrame).toContain("Reconnect");
			expect(failedFrame).toContain("[redacted]");
			expect(failedFrame).not.toContain("diagnostics.example.test");

			await act(async () => {
				await setup.mockInput.typeText(" ");
				await Bun.sleep(20);
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (panel.getSnapshot().items[0]?.status === "success") {
					break;
				}
			}
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await flushTestRenderer(setup);
				if (!setup.captureCharFrame().includes("Working...")) {
					break;
				}
			}
			expect(connectionAttempts).toBe(2);
			expect(panel.getSnapshot().items[0]).toMatchObject({
				actions: [
					{ id: "toggle", label: "Disable", shortcut: "space" },
					{ id: "exposure", label: "Hide tools", shortcut: "space" },
				],
				status: "success",
				summary: "0 tools • remote • direct • no auth • global",
			});

			await act(async () => {
				await setup.mockInput.pressTab();
			});
			await flushTestRenderer(setup);
			expect(setup.captureCharFrame()).toContain("Hide tools");
			await act(async () => {
				await setup.mockInput.pressTab();
			});
			await flushTestRenderer(setup);
			expect(setup.captureCharFrame()).toContain("Disable");
			await act(async () => {
				await loadedRuntime.runStatusPanelAction(
					"mcp",
					"servers",
					"broken",
					"toggle"
				);
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (panel.getSnapshot().items[0]?.status === "idle") {
					break;
				}
			}
			expect(panel.getSnapshot().items[0]).toMatchObject({
				actions: [
					{ id: "toggle", label: "Enable", shortcut: "space" },
					{ id: "exposure", label: "Hide tools", shortcut: "space" },
				],
				status: "idle",
				summary: "0 tools • remote • direct • no auth • global",
			});
			expect(await Bun.file(mcpConfigPath).json()).toMatchObject({
				mcpServers: {
					broken: {
						url: "https://configured.example.test/mcp?token=configured-secret",
					},
				},
			});
			expect(
				await Bun.file(path.join(workspace, ".wincode", "mcp.json")).json()
			).toMatchObject({ mcpServers: { broken: { enabled: false } } });
		} finally {
			setup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("MCP settings persist beside the nested project definition that owns the server", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "wincode-mcp-project-owner-")
	);
	const projectRoot = path.join(root, "project");
	const workspace = path.join(projectRoot, "workspace");
	const parentConfigPath = path.join(projectRoot, ".wincode", "mcp.json");
	const workspaceConfigPath = path.join(workspace, ".wincode", "mcp.json");
	await mkdir(path.join(projectRoot, ".git"), { recursive: true });
	await mkdir(path.dirname(parentConfigPath), { recursive: true });
	await mkdir(path.dirname(workspaceConfigPath), { recursive: true });
	await Bun.write(parentConfigPath, "{}\n");
	await Bun.write(
		workspaceConfigPath,
		JSON.stringify({
			mcpServers: { shared: { url: "https://mcp.example.test" } },
		})
	);

	const trustedProjectRoots = await Promise.all([
		realpath(projectRoot),
		realpath(workspace),
	]);
	const configStore = createConfigStore({
		homeRoot: root,
		trustedProjectRoots,
	});
	const projectSources = (
		await configStore.getNamespaceSnapshot(workspace, "mcp")
	).sources.filter(({ scope }) => scope === "project");
	expect(projectSources.map(({ path: sourcePath }) => sourcePath)).toEqual([
		parentConfigPath,
		workspaceConfigPath,
	]);

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					factory: createMcpPluginFactory({
						createClient: (): McpClient => ({
							callTool: async () => ({ content: [] }),
							close: async () => undefined,
							connect: async () => undefined,
							listTools: async () => [],
							setToolsChangedListener: () => undefined,
						}),
					}),
					id: "mcp",
				},
			],
			cliPaths: [],
			config: {
				configStore,
				cwd: workspace,
				homeRoot: root,
				trustedProjectRoots,
				workspace,
			},
			distributionPlugins: [],
		});
		const panel = runtime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
		if (panel === undefined) {
			throw new Error("The MCP Plugin did not register its status panel.");
		}
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (panel.getSnapshot().items[0]?.status === "success") {
				break;
			}
			await Bun.sleep(5);
		}

		await runtime.runStatusPanelAction("mcp", "servers", "shared", "toggle");

		expect(await Bun.file(parentConfigPath).json()).toEqual({});
		expect(await Bun.file(workspaceConfigPath).json()).toMatchObject({
			mcpServers: {
				shared: { enabled: false, url: "https://mcp.example.test" },
			},
		});
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});
