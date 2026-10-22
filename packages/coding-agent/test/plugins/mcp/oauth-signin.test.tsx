import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { McpClient } from "@wincode/mcp";
import { createMcpPluginFactory } from "@wincode/mcp/plugin";
import { act, useEffect } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import type {
	PluginRuntime,
	PluginStatusPanelDescriptor,
} from "@/modules/plugins/runtime";
import { PluginStatusPanelDialogContent } from "@/modules/plugins/ui/plugin-status-panel-dialog";
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
import { flushTestRenderer, frameIncludes } from "../../support/opentui";

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

test("/mcps sign-in accepts a pasted OAuth redirect when the loopback callback is unavailable", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-mcp-oauth-paste-")
	);
	const workspace = path.join(root, "workspace");
	const redirectUrl =
		"http://127.0.0.1:45831/oauth/callback?code=oauth-code&state=oauth-state";
	await fs.mkdir(workspace, { recursive: true });
	await Bun.write(
		path.join(root, ".wincode", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				account: { auth: "oauth", url: "https://mcp.example.test" },
			},
		})
	);

	let connectionAttempts = 0;
	let pastedRedirect: string | undefined;
	let runtime: PluginRuntime | undefined;
	try {
		runtime = await loadPlugins({
			bundledPlugins: [
				{
					factory: createMcpPluginFactory({
						createClient: (): McpClient => ({
							callTool: async () => ({ content: [] }),
							close: async () => undefined,
							connect: async () => {
								connectionAttempts += 1;
								if (connectionAttempts === 1) {
									throw new Error("OAuth is required.");
								}
							},
							listTools: async () => [],
							setToolsChangedListener: () => undefined,
						}),
						loginOAuth: async (_config, readRedirectUrl) => {
							if (readRedirectUrl === undefined) {
								throw new Error("The Plugin did not provide redirect input.");
							}
							const callback = Promise.withResolvers<URL>();
							pastedRedirect = (
								await readRedirectUrl(callback.promise)
							).toString();
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
		});
		const panel = runtime
			.getStatusPanels()
			.find(({ id, pluginId }) => id === "servers" && pluginId === "mcp");
		if (panel === undefined) {
			throw new Error("The MCP Plugin did not register its status panel.");
		}
		for (let attempt = 0; attempt < 10; attempt += 1) {
			if (panel.getSnapshot().items[0]?.status === "error") {
				break;
			}
			await Bun.sleep(5);
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
			{ height: 20, width: 100 }
		);
		try {
			await act(async () => {
				await setup.mockInput.pressTab();
			});
			await flushTestRenderer(setup);
			await act(async () => {
				await setup.mockInput.typeText(" ");
			});
			for (let attempt = 0; attempt < 10; attempt += 1) {
				await flushTestRenderer(setup);
				if (frameIncludes(setup, "Paste the full OAuth redirect URL")) {
					break;
				}
			}
			expect(setup.captureCharFrame()).toContain(
				"Paste the full OAuth redirect URL"
			);
			await act(async () => {
				await setup.mockInput.typeText(redirectUrl);
				setup.mockInput.pressEnter();
			});
			for (let attempt = 0; attempt < 10; attempt += 1) {
				await flushTestRenderer(setup);
				if (pastedRedirect !== undefined) {
					break;
				}
				await Bun.sleep(5);
			}
			expect(pastedRedirect).toBe(redirectUrl);
		} finally {
			setup.renderer.destroy();
		}
	} finally {
		await runtime?.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});
