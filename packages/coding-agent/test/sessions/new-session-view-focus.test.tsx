import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { TextareaRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createConnections } from "@wincode/ai/connections";
import { act } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { createMcpRegistry, McpProvider } from "@/modules/mcp";
import { ModelPricingProvider } from "@/modules/model-pricing";
import {
	createPermissionService,
	PermissionServiceProvider,
} from "@/modules/permissions";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { writeComposerDraft } from "@/modules/sessions/hooks/input-controller/draft-store";
import { NewSessionView } from "@/modules/sessions/ui/views/new-session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { CommandControllerProvider } from "@/tui/commands/command-controller-provider";

process.env.WINCODE_LOCAL_DB_PATH = ":memory:";

describe("NewSessionView composer focus", () => {
	test("returns focus after pointer movement and a background click without moving the caret", async () => {
		const workspace = process.cwd();
		const router = createRouter({
			history: createMemoryHistory({ initialEntries: ["/"] }),
			routeTree: createRootRoute({}),
		});
		await router.load();
		writeComposerDraft("new-session", "");

		const app = (
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{
						configStore: createConfigStore({
							fs: {
								readFile: async () =>
									Promise.reject(
										Object.assign(new Error("Test config is unavailable."), {
											code: "ENOENT",
										})
									),
							},
						}),
						homeRoot: os.homedir(),
						workspace,
					}}
				>
					<ToastProvider>
						<ConnectionsProvider connections={createConnections()}>
							<PermissionServiceProvider service={createPermissionService()}>
								<AgentRegistryProvider>
									<KeyboardLayerProvider>
										<ApprovalPanelsProvider>
											<PromptConfigProvider>
												<ModelPricingProvider pricing={{}}>
													<DialogProvider>
														<McpProvider
															closeRegistryOnUnmount={false}
															createRegistry={() =>
																createMcpRegistry({
																	loadConfig: async () => ({
																		diagnostics: [],
																		servers: {},
																	}),
																	workspace,
																})
															}
															workspace={workspace}
														>
															<RouterContextProvider router={router}>
																<CommandControllerProvider>
																	<NewSessionView />
																</CommandControllerProvider>
															</RouterContextProvider>
														</McpProvider>
													</DialogProvider>
												</ModelPricingProvider>
											</PromptConfigProvider>
										</ApprovalPanelsProvider>
									</KeyboardLayerProvider>
								</AgentRegistryProvider>
							</PermissionServiceProvider>
						</ConnectionsProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>
		);
		let renderedSetup: TestRendererSetup | undefined;
		await act(async () => {
			const mounted = await testRender(app, { height: 24, width: 100 });
			renderedSetup = mounted;
			await Bun.sleep(20);
			await mounted.renderOnce();
		});
		if (renderedSetup === undefined) {
			throw new Error("The new-session view did not render.");
		}
		const setup = renderedSetup;

		try {
			const composer = setup.renderer.root.findDescendantById(
				"new-session-view-composer"
			);
			expect(composer).toBeInstanceOf(TextareaRenderable);
			if (!(composer instanceof TextareaRenderable)) {
				throw new Error(
					"The new-session composer did not receive startup focus."
				);
			}
			expect(setup.renderer.currentFocusedRenderable).toBe(composer);

			await act(async () => {
				await setup.mockInput.typeText("before");
			});
			expect(composer.cursorOffset).toBe(6);

			await act(async () => {
				composer.blur();
				await setup.mockMouse.moveTo(0, 0);
			});
			await setup.flush({ maxPasses: 20 });
			expect(setup.renderer.currentFocusedRenderable).toBe(composer);

			await act(async () => {
				composer.blur();
				await setup.mockMouse.pressDown(0, 0);
				await setup.mockMouse.release(0, 0);
				await setup.mockInput.typeText("-after");
			});
			await act(async () => {
				await setup.renderOnce();
			});

			expect(composer.plainText).toBe("before-after");
			expect(composer.cursorOffset).toBe(12);
		} finally {
			setup.renderer.destroy();
		}
	});
});
