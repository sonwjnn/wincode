import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import type { RefreshModelsOptions } from "@wincode/ai/sdk";
import type { OpenAIBrowserLoginOptions } from "@wincode/ai/sdk/providers/openai";
import { act, useEffect, useRef } from "react";
import type { PluginProviderConnectContext } from "@/modules/plugins/public";
import type {
	InteractiveProviderController,
	PluginProviderConnectionOutcome,
} from "@/modules/providers/interactive-provider-controller";
import { ProviderSdkConnectDialogContent } from "@/modules/providers/ui/provider-sdk-connect-dialog";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { flushTestRenderer } from "../support/opentui";

const providerOptions = [
	{
		displayName: "OpenRouter Provider SDK",
		kind: "openrouter" as const,
		providerId: "openrouter",
	},
	{
		displayName: "Example Plugin Provider",
		kind: "plugin" as const,
		providerId: "example_provider",
	},
	{
		displayName: "OpenAI browser sign-in",
		kind: "openai-oauth" as const,
		providerId: "openai",
	},
	{
		displayName: "OpenAI Provider SDK",
		kind: "api-key" as const,
		providerId: "openai",
	},
];

const renderConnectDialog = async (
	controller: InteractiveProviderController,
	includeUnderlyingDialog = false
): Promise<
	Readonly<{ openOtherDialog: () => void; setup: TestRendererSetup }>
> => {
	const openOtherDialog = Promise.withResolvers<() => void>();
	function Harness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			if (includeUnderlyingDialog) {
				dialog.open({
					children: <text>Underlying dialog remains open</text>,
					title: "Underlying dialog",
				});
			}
			dialog.open({
				children: <ProviderSdkConnectDialogContent controller={controller} />,
				title: "Connect Provider",
			});
			openOtherDialog.resolve(() =>
				dialog.open({
					children: <text>Other dialog remains open</text>,
					title: "Other dialog",
				})
			);
		}, [dialog]);
		return null;
	}

	const setup = await testRender(
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
	await flushTestRenderer(setup, 3);
	return { openOtherDialog: await openOtherDialog.promise, setup };
};

const selectPluginProvider = async (
	setup: TestRendererSetup
): Promise<void> => {
	await act(() => setup.mockInput.pressArrow("down"));
	await act(() => setup.mockInput.pressEnter());
	await flushTestRenderer(setup, 3);
};

test("built-in Provider API keys are masked and saved only through the host controller", async () => {
	const selected = Promise.withResolvers<{
		apiKey: string;
		providerId: string;
	}>();
	const controller = fromPartial<InteractiveProviderController>({
		connectProviderApiKey: async (providerId: string, apiKey: string) => {
			selected.resolve({ apiKey, providerId });
			return [];
		},
		getConnectableProviders: () => [
			{
				displayName: "Google Provider SDK",
				kind: "api-key",
				providerId: "google",
			},
		],
	});
	const { setup } = await renderConnectDialog(controller);
	const fakeSecret = "never-render-this-google-key";

	try {
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		const apiKeyInput = setup.renderer.root.findDescendantById(
			"connection-api-key-input"
		);
		if (!(apiKeyInput instanceof InputRenderable)) {
			throw new Error("The built-in Provider API-key input did not render.");
		}
		await act(() => {
			for (const character of fakeSecret) {
				apiKeyInput.value += character;
				apiKeyInput.onContentChange?.({});
			}
		});
		await flushTestRenderer(setup, 3);
		expect(apiKeyInput.value).toBe("•".repeat(fakeSecret.length));
		const maskedFrame = setup.captureCharFrame();
		expect(maskedFrame).toContain("•".repeat(fakeSecret.length));
		expect(maskedFrame).not.toContain(fakeSecret);

		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		expect(await selected.promise).toEqual({
			apiKey: fakeSecret,
			providerId: "google",
		});
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("OpenAI API-key selection remains distinct from OAuth despite a shared Provider ID", async () => {
	const selected = Promise.withResolvers<{
		apiKey: string;
		providerId: string;
	}>();
	const controller = fromPartial<InteractiveProviderController>({
		connectProviderApiKey: async (providerId: string, apiKey: string) => {
			selected.resolve({ apiKey, providerId });
			return [];
		},
		getConnectableProviders: () => providerOptions,
	});
	const { setup } = await renderConnectDialog(controller);
	const fakeSecret = "selected-openai-api-key";

	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		expect(setup.captureCharFrame()).toContain(
			"Paste OpenAI Provider SDK API key"
		);
		const apiKeyInput = setup.renderer.root.findDescendantById(
			"connection-api-key-input"
		);
		if (!(apiKeyInput instanceof InputRenderable)) {
			throw new Error("The OpenAI Provider API-key input did not render.");
		}
		await act(() => {
			for (const character of fakeSecret) {
				apiKeyInput.value += character;
				apiKeyInput.onContentChange?.({});
			}
		});
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		expect(await selected.promise).toEqual({
			apiKey: fakeSecret,
			providerId: "openai",
		});
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("OpenAI browser sign-in uses the explicit host OAuth interaction", async () => {
	const started = Promise.withResolvers<AbortSignal | undefined>();
	const controller = fromPartial<InteractiveProviderController>({
		connectOpenAIOAuth: async (options?: OpenAIBrowserLoginOptions) => {
			started.resolve(options?.signal);
			return [];
		},
		getConnectableProviders: () => providerOptions,
	});
	const { setup } = await renderConnectDialog(controller);

	try {
		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 4);
		expect(await started.promise).toBeDefined();
		expect(setup.captureCharFrame()).not.toContain("Paste OpenAI API key");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("Escape closes only the top Provider connect dialog and leaves the underlying dialog open", async () => {
	const controller = fromPartial<InteractiveProviderController>({
		getConnectableProviders: () => providerOptions,
	});
	const { setup } = await renderConnectDialog(controller, true);

	try {
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 3);
		expect(setup.captureCharFrame()).toContain("Paste OpenRouter API key");

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 3);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Underlying dialog remains open");
		expect(frame).not.toContain("Paste OpenRouter API key");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("dismissing Provider connect aborts its interaction signal", async () => {
	const connectStarted = Promise.withResolvers<AbortSignal | undefined>();
	const connectResult = Promise.withResolvers<
		PluginProviderConnectionOutcome | undefined
	>();
	const controller = fromPartial<InteractiveProviderController>({
		connectPluginProvider: async (
			_providerId: string,
			_requestTextInput: PluginProviderConnectContext["requestTextInput"],
			options?: RefreshModelsOptions
		): Promise<PluginProviderConnectionOutcome | undefined> => {
			connectStarted.resolve(options?.signal);
			return connectResult.promise;
		},
		getConnectableProviders: () => providerOptions,
	});
	const { setup } = await renderConnectDialog(controller);

	try {
		await selectPluginProvider(setup);
		const signal = await connectStarted.promise;
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(signal?.aborted).toBe(true);
		connectResult.resolve(undefined);
	} finally {
		connectResult.resolve(undefined);
		await act(() => setup.renderer.destroy());
	}
});

test("saved credentials are reported after dismissal without closing a different dialog", async () => {
	const connectStarted = Promise.withResolvers<AbortSignal | undefined>();
	const connectResult = Promise.withResolvers<
		PluginProviderConnectionOutcome | undefined
	>();
	const controller = fromPartial<InteractiveProviderController>({
		connectPluginProvider: async (
			_providerId: string,
			_requestTextInput: PluginProviderConnectContext["requestTextInput"],
			options?: RefreshModelsOptions
		): Promise<PluginProviderConnectionOutcome | undefined> => {
			connectStarted.resolve(options?.signal);
			return connectResult.promise;
		},
		getConnectableProviders: () => providerOptions,
	});
	const { openOtherDialog, setup } = await renderConnectDialog(controller);

	try {
		await selectPluginProvider(setup);
		const signal = await connectStarted.promise;
		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(signal?.aborted).toBe(true);

		await act(() => openOtherDialog());
		await flushTestRenderer(setup, 2);
		await act(async () => {
			connectResult.resolve({ kind: "saved-before-cancelled" });
			await Promise.resolve();
		});
		await flushTestRenderer(setup, 3);

		const frame = setup.captureCharFrame();
		expect(frame).toContain("Other dialog remains open");
		expect(frame).toContain("credentials were saved before");
	} finally {
		connectResult.resolve({ kind: "saved-before-cancelled" });
		await act(() => setup.renderer.destroy());
	}
});

test("opening and dismissing nested Plugin text input does not abort its parent flow", async () => {
	const connectStarted = Promise.withResolvers<AbortSignal | undefined>();
	const controller = fromPartial<InteractiveProviderController>({
		connectPluginProvider: async (
			_providerId: string,
			requestTextInput: PluginProviderConnectContext["requestTextInput"],
			options?: RefreshModelsOptions
		): Promise<PluginProviderConnectionOutcome | undefined> => {
			const signal = options?.signal;
			connectStarted.resolve(signal);
			if (signal === undefined) {
				return;
			}
			const value = await requestTextInput("Enter a fake Provider key", signal);
			return value === undefined
				? undefined
				: { kind: "connected", models: [] };
		},
		getConnectableProviders: () => providerOptions,
	});
	const { setup } = await renderConnectDialog(controller);

	try {
		await selectPluginProvider(setup);
		const signal = await connectStarted.promise;
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
		expect(setup.captureCharFrame()).toContain("Enter a fake Provider key");

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 3);
		expect(signal?.aborted).toBe(false);
		expect(setup.captureCharFrame()).toContain("Example Plugin Provider");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
