import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { createConnections } from "@wincode/ai/connections";
import { act } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { StatusBar } from "@/modules/prompt-settings/ui/prompt-status-bar";
import { ConfigProvider } from "@/shared/config/config-provider";
import { RoundedBorderChars } from "@/shared/constants";
import {
	ThemeProvider,
	useTheme,
} from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import {
	createInMemoryConfigStore,
	TEST_HOME_ROOT,
} from "../support/config-store";
import { modelId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

function ComposerPreview() {
	const { colors } = useTheme();
	return (
		<box position="relative" width="100%">
			<BorderedContentBlock
				border={["top", "right", "bottom", "left"]}
				colors={colors}
				customBorderChars={RoundedBorderChars}
				marginBottom={0}
				paddingX={1}
				paddingY={0}
			>
				<text>Prompt</text>
			</BorderedContentBlock>
			<StatusBar />
		</box>
	);
}

test("shows provider, model, and thinking level over the composer border without agent", async () => {
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
					<ConnectionsProvider
						connections={createConnections({
							vault: {
								load: async () => null,
								replaceValidated: async () => undefined,
							},
						})}
					>
						<AgentRegistryProvider>
							<PromptConfigProvider
								initialModel={{
									modelId: modelId("claude-sonnet-5"),
									providerId: "anthropic",
								}}
							>
								<ComposerPreview />
							</PromptConfigProvider>
						</AgentRegistryProvider>
					</ConnectionsProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height: 8, width: 80 }
	);

	try {
		await flushTestRenderer(setup, 3);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Anthropic");
		expect(frame).toContain("Claude Sonnet 5");
		expect(frame).toContain("low");
		const providerRow = frame
			.split("\n")
			.find((line) => line.includes("Anthropic"));
		expect(providerRow).toContain("╰");
		expect(providerRow).toContain("╯");
		expect(frame).not.toContain("Build");
	} finally {
		act(() => setup.renderer.destroy());
	}
});
