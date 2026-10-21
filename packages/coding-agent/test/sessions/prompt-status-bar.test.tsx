import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { StatusBar } from "@/modules/prompt-settings/ui/prompt-status-bar";
import { ConfigProvider } from "@/shared/config/config-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	createInMemoryConfigStore,
	TEST_HOME_ROOT,
} from "../support/config-store";
import { modelId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

test("shows the provider model and effort without the agent label", async () => {
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ConfigProvider
				value={{
					configStore: createInMemoryConfigStore(),
					homeRoot: TEST_HOME_ROOT,
					workspace: "/workspace",
				}}
			>
				<ToastProvider>
					<AgentRegistryProvider>
						<PromptConfigProvider
							initialModel={{
								modelId: modelId("claude-sonnet-5"),
								providerId: "anthropic",
							}}
							initialThinkingLevel="low"
						>
							<StatusBar />
						</PromptConfigProvider>
					</AgentRegistryProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height: 8, width: 80 }
	);

	try {
		await flushTestRenderer(setup, 3);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("anthropic/claude-sonnet-5 ∙ low");
		expect(frame).not.toContain("Build");
	} finally {
		act(() => setup.renderer.destroy());
	}
});
