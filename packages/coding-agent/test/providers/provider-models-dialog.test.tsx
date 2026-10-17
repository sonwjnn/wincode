import { expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ProviderModel } from "@wincode/ai";
import { act, useEffect, useRef } from "react";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type {
	ProviderModelSelection,
	ProviderModelSelectionCandidate,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { flushTestRenderer } from "../support/opentui";

const models: readonly ProviderModel[] = [
	{ modelId: "gpt-4o", protocolId: "openai-responses", providerId: "openai" },
	{
		modelId: "claude-sonnet-4-6",
		protocolId: "anthropic",
		providerId: "anthropic",
	},
];
const candidates = models.map((model) =>
	fromPartial<ProviderModelSelectionCandidate>({ model })
);
const controller = fromPartial<InteractiveProviderController>({
	getAvailableProviderModelSelectionCandidates: async () => candidates,
});

test("model picker preserves its search, Recent, and provider-group surface", async () => {
	function Harness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			dialog.open({
				children: (
					<ProviderModelsDialogContent
						controller={controller}
						currentModel={fromPartial<ProviderModelSelection>({
							modelId: "gpt-4o",
							providerId: "openai",
						})}
						onSelectModel={() => undefined}
						recentSelections={[
							fromPartial<ProviderModelSelection>({
								modelId: "claude-sonnet-4-6",
								providerId: "anthropic",
							}),
						]}
					/>
				),
				title: "Select Model",
			});
		}, [dialog]);
		return null;
	}

	const setup: TestRendererSetup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<Harness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	try {
		await flushTestRenderer(setup, 3);
		await setup.waitForFrame((frame) => frame.includes("gpt-4o"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Search models");
		expect(frame).toContain("Recent");
		expect(frame).toContain("OpenAI");
		expect(frame).toContain("Anthropic");
		expect(frame).not.toContain(
			"Available models are filtered by the current user's credentials."
		);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
