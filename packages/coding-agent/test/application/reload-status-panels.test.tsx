import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { createMcpPluginFactory } from "@wincode/mcp/plugin";
import { act, useReducer } from "react";
import type { ApplicationResourceLoader } from "@/modules/application/resource-loader";
import { loadPlugins } from "@/modules/plugins/loader";
import { PluginStatusIndicator } from "@/modules/plugins/ui/plugin-status-indicator";
import { resetInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { createConfigStore } from "@/shared/config/config-store";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import { reloadInteractiveResources } from "@/tui/commands/reload-resources";
import { flushTestRenderer } from "../support/opentui";

test("MCP status remains renderable while the first reload shuts down its previous runtime", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "wincode-reload-status-"));
	const configRuntime = {
		configStore: createConfigStore({ configRoot: root, homeRoot: root }),
		cwd: root,
		homeRoot: root,
		workspace: root,
	};
	const createRuntime = () =>
		loadPlugins({
			bundledPlugins: [
				{
					factory: createMcpPluginFactory({
						loadConfig: async () => ({ diagnostics: [], servers: {} }),
					}),
					id: "mcp",
				},
			],
			cliPaths: [],
			config: configRuntime,
			distributionPlugins: [],
		});
	const oldRuntime = await createRuntime();
	const replacement = await createRuntime();
	const shutdownFinished = Promise.withResolvers<void>();
	const allowReplacement = Promise.withResolvers<void>();
	const previous = {
		...oldRuntime,
		shutdown: async () => {
			await oldRuntime.shutdown();
			shutdownFinished.resolve();
			await allowReplacement.promise;
		},
	};
	const resourceLoader: ApplicationResourceLoader = {
		reload: async () => ({
			configRuntime,
			diagnostics: [],
			pluginRuntime: replacement,
			pluginRuntimeChanged: true,
			trustChanged: false,
		}),
	};
	await resetInteractiveSessionHostManager();
	setInteractiveRuntimeContext({
		args: [],
		configRuntime,
		cwd: root,
		pluginRuntime: previous,
		resourceLoader,
	});
	let redraw: () => void = () => undefined;
	const Indicator = () => {
		const [, rerender] = useReducer((count: number) => count + 1, 0);
		redraw = rerender;
		return <PluginStatusIndicator />;
	};
	const setup = await testRender(
		<ThemeProvider>
			<Indicator />
		</ThemeProvider>,
		{ height: 8, width: 80 }
	);
	let reload: Promise<void> | undefined;
	try {
		await flushTestRenderer(setup);
		expect(setup.captureCharFrame()).toContain("MCPs");
		reload = reloadInteractiveResources({
			dialog: { open: () => undefined },
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: () => undefined },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		await shutdownFinished.promise;
		expect(previous.getStatusPanels()[0]?.getSnapshot()).toMatchObject({
			items: [],
			status: "idle",
			summary: "0",
		});
		await act(async () => {
			redraw();
			await flushTestRenderer(setup);
		});
		// The old panel remains mounted during a resource swap; it must not crash
		// when React renders before the new runtime is published.
		expect(setup.captureCharFrame()).toContain("MCPs");
	} finally {
		allowReplacement.resolve();
		await reload?.catch(() => undefined);
		setup.renderer.destroy();
		await resetInteractiveSessionHostManager();
		await oldRuntime.shutdown();
		await replacement.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
