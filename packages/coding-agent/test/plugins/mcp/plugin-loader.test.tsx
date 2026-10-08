import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { PluginBeforeAgentTurnContext } from "@wincode/coding-agent";
import {
	DEFAULT_MCP_TIMEOUTS,
	type McpClient,
	type McpConfigResult,
} from "@wincode/mcp";
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
import { agentId } from "../../support/identifiers";
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
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	const configPath = path.join(configRoot, "wincode.jsonc");
	await mkdir(configRoot, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await Bun.write(
		configPath,
		JSON.stringify({
			mcp: {
				offline: {
					enabled: false,
					type: "remote",
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
				configStore: createConfigStore({ configRoot, homeRoot: root }),
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
		expect(panel.getSnapshot()).toMatchObject({
			items: [
				{
					actions: [{ id: "toggle", label: "Enable", shortcut: "space" }],
					id: "offline",
					label: "offline",
					status: "idle",
					summary: "0 tools • remote",
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
					mcp: {
						offline: {
							enabled: false,
							type: "remote",
							url: "https://mcp.example.test",
						},
						refreshed: {
							enabled: false,
							type: "remote",
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

test("MCP tools resolve permissions under their owner-qualified actions", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-mcp-permission-"));
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	await mkdir(configRoot, { recursive: true });
	await mkdir(workspace, { recursive: true });

	const config: McpConfigResult = {
		diagnostics: [],
		servers: {
			external: {
				disabled: false,
				name: "external",
				permission: "allow",
				timeout: DEFAULT_MCP_TIMEOUTS,
				type: "remote",
				url: "https://mcp.example.test",
			},
		},
	};
	const dependencies: McpPluginDependencies = {
		createClient: (): McpClient => ({
			callTool: async () => ({ content: [] }),
			close: async () => undefined,
			connect: async () => undefined,
			listTools: async () => [
				{
					description: "Enumerate external directories.",
					inputSchema: { type: "object" },
					name: "directory",
				},
			],
			setToolsChangedListener: () => undefined,
		}),
		loadConfig: async () => config,
	};
	const resolvedActions: string[] = [];
	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{ factory: createMcpPluginFactory(dependencies), id: "mcp" },
			],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ configRoot, homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
				workspace,
			},
			distributionPlugins: [],
		});

		const tools = await runtime.resolveToolsForTurn({
			agentId: agentId("build"),
			resolvePluginPermission: async (action) => {
				resolvedActions.push(action);
				return { decision: "allow", safety: false };
			},
			sessionId: "mcp-permission-session",
			signal: new AbortController().signal,
			workspace,
		} satisfies PluginBeforeAgentTurnContext);

		expect(resolvedActions).toEqual(["plugin:mcp:external_directory"]);
		expect(runtime.diagnostics).toEqual([]);
		expect(tools).toContainEqual(
			expect.objectContaining({
				permissionAction: "plugin:mcp:external_directory",
				permissionDecision: "allow",
				permissionSafety: false,
			})
		);
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});

test("a custom command takes precedence over a distributed Plugin command", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugin-command-"));
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	const customCommands = path.join(workspace, ".wincode", "commands");
	await mkdir(configRoot, { recursive: true });
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
		configStore: createConfigStore({ configRoot, homeRoot: root }),
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
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	await mkdir(configRoot, { recursive: true });
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
				configStore: createConfigStore({ configRoot, homeRoot: root }),
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
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	await mkdir(configRoot, { recursive: true });
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
				configStore: createConfigStore({ configRoot, homeRoot: root }),
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
	const configRoot = path.join(root, "config");
	const workspace = path.join(root, "workspace");
	await mkdir(configRoot, { recursive: true });
	await mkdir(workspace, { recursive: true });

	let connectionAttempts = 0;
	const failureUrl =
		"https://diagnostics.example.test/path?token=leaked-secret";
	const config: McpConfigResult = {
		diagnostics: [],
		servers: {
			broken: {
				disabled: false,
				headers: { Authorization: "Bearer configured-secret" },
				name: "broken",
				permission: "ask",
				timeout: DEFAULT_MCP_TIMEOUTS,
				type: "remote",
				url: "https://configured.example.test/mcp?token=configured-secret",
			},
		},
	};
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
		loadConfig: async () => config,
	};

	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{ factory: createMcpPluginFactory(dependencies), id: "mcp" },
			],
			cliPaths: [],
			config: {
				configStore: createConfigStore({ configRoot, homeRoot: root }),
				cwd: workspace,
				homeRoot: root,
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
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (panel.getSnapshot().items[0]?.status === "success") {
					break;
				}
			}
			expect(connectionAttempts).toBe(2);
			expect(panel.getSnapshot().items[0]).toMatchObject({
				actions: [{ id: "toggle", label: "Disable", shortcut: "space" }],
				status: "success",
			});

			await act(async () => {
				await setup.mockInput.typeText(" ");
			});
			for (let attempt = 0; attempt < 5; attempt += 1) {
				await flushTestRenderer(setup);
				if (panel.getSnapshot().items[0]?.status === "idle") {
					break;
				}
			}
			expect(panel.getSnapshot().items[0]).toMatchObject({
				actions: [{ id: "toggle", label: "Enable", shortcut: "space" }],
				status: "idle",
			});
		} finally {
			setup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		await rm(root, { force: true, recursive: true });
	}
});
