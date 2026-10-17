import { expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import { act, useEffect, useRef } from "react";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import { ProviderSdkConnectDialogContent } from "@/modules/providers/ui/provider-sdk-connect-dialog";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { flushTestRenderer } from "../support/opentui";

let oauthStarted = false;
const controller = fromPartial<InteractiveProviderController>({
	getAvailableModels: async () => [],
	getConnectableProviders: () => [
		{
			connectOAuth: async () => {
				oauthStarted = true;
				return [];
			},
			displayName: "OpenAI browser sign-in",
			kind: "oauth",
			methodId: "openai-browser",
			providerId: "openai",
		},
		{
			connectApiKey: async () => [],
			displayName: "OpenAI Provider SDK",
			kind: "api-key",
			methodId: "provider-api-key",
			providerId: "openai",
		},
	],
});

test("legacy provider connect flow still shows a separate method picker", async () => {
	function Harness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			dialog.open({
				children: <ProviderSdkConnectDialogContent controller={controller} />,
				title: "Connect",
			});
		}, [dialog]);
		return null;
	}

	const setup: TestRendererSetup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ToastProvider>
					<DialogProvider>
						<Harness />
					</DialogProvider>
				</ToastProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	try {
		await flushTestRenderer(setup, 3);
		const providerFrame = setup.captureCharFrame();
		expect(providerFrame).toContain("Search providers");
		expect(providerFrame).toContain("Browser sign-in or API key");
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		const methodFrame = setup.captureCharFrame();
		expect(methodFrame).toContain("Choose method");
		expect(methodFrame).toContain("Search methods");
		expect(methodFrame).toContain("Browser sign-in");
		expect(methodFrame).toContain("API key");
		expect(oauthStarted).toBe(false);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
