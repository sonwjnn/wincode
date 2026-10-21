import { expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	createProviderCollection,
	type Provider,
	type ProviderModel,
} from "@wincode/ai";
import { act, useEffect, useRef } from "react";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import type {
	ProviderModelSelection,
	ProviderModelSelectionCandidate,
	ProviderModelSelectionRefreshResult,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { flushTestRenderer } from "../support/opentui";
import { createInMemoryCredentialStore } from "../support/provider-stores";

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
const createFailingDiscoveryController = () => {
	const credentialStore = new Map<string, unknown>([
		["openai", "fixture-provider-credential"],
	]);
	const modelStore = new Map<string, readonly ProviderModel[]>([
		["openai", models.filter((model) => model.providerId === "openai")],
	]);
	const providers = createProviderCollection({
		credentialStore: createInMemoryCredentialStore(credentialStore),
		modelStore: {
			get: (providerId) => modelStore.get(providerId),
			set: (providerId, providerModels) =>
				void modelStore.set(providerId, providerModels),
		},
	});
	const provider: Provider = {
		discoverModels: async () => {
			throw new Error("fixture discovery unavailable");
		},
		id: "openai",
		models: [],
		resolveAuthorization: async ({ credential }) =>
			credential === undefined ? null : { authorization: credential },
		async *streamChat() {
			yield { type: "finish" };
		},
	};
	providers.register(provider);
	return {
		controller: createInteractiveProviderController(providers, {
			getDiscoverableProviderIds: () => ["openai"],
			withSessionWork: async (action) => action(),
		}),
		providers,
	};
};
const createUnconnectedOpenRouterController = () => {
	const providers = createProviderCollection({
		credentialStore: createInMemoryCredentialStore(new Map()),
		modelStore: {
			get: () => undefined,
			set: () => undefined,
		},
	});
	providers.register({
		discoverModels: async () => {
			throw new Error("Discovery should not run without credentials.");
		},
		id: "openrouter",
		models: [],
		resolveAuthorization: async ({ credential }) =>
			credential === undefined ? null : { authorization: credential },
		async *streamChat() {
			yield { type: "finish" };
		},
	});
	return {
		controller: createInteractiveProviderController(providers, {
			getDiscoverableProviderIds: () => ["openrouter"],
			withSessionWork: async (action) => action(),
		}),
		providers,
	};
};

const renderPicker = async (
	pickerController: InteractiveProviderController,
	recentSelections: readonly ProviderModelSelection[] = [],
	onSelectModel: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void | Promise<void> = () => undefined
): Promise<TestRendererSetup> => {
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
						controller={pickerController}
						currentModel={fromPartial<ProviderModelSelection>({
							modelId: "gpt-4o",
							providerId: "openai",
						})}
						onSelectModel={onSelectModel}
						recentSelections={recentSelections}
					/>
				),
				title: "Select Model",
			});
		}, [dialog]);
		return null;
	}

	return testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<Harness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
};

const selectProviderModelSelectionCandidate: NonNullable<
	InteractiveProviderController["selectProviderModelSelectionCandidate"]
> = async <Result,>(
	candidate: ProviderModelSelectionCandidate,
	action: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => Result | Promise<Result>
): Promise<Result> =>
	action(
		candidate.model,
		fromPartial<ProviderModelSelection>({
			modelId: candidate.model.modelId,
			providerId: candidate.model.providerId,
		})
	);

test("model picker preserves its search, Recent, and provider-group surface", async () => {
	const cachedCandidates =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const testController = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: async () => ({
			candidates,
			failedProviderIds: [],
			refreshedProviderIds: ["openai", "anthropic"],
		}),
	});
	const setup = await renderPicker(testController, [
		fromPartial<ProviderModelSelection>({
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
		}),
	]);
	try {
		await flushTestRenderer(setup, 1);
		await act(async () => {
			cachedCandidates.resolve(candidates);
			await Bun.sleep(20);
		});
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

test("refreshes known models in the background after cached models render", async () => {
	const refreshedCandidate = fromPartial<ProviderModelSelectionCandidate>({
		model: {
			modelId: "gpt-5.1",
			protocolId: "openai-responses",
			providerId: "openai",
		},
	});
	const cachedCandidates =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const refresh = Promise.withResolvers<ProviderModelSelectionRefreshResult>();
	const refreshStarted = Promise.withResolvers<void>();
	const refreshController = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: () => {
			refreshStarted.resolve();
			return refresh.promise;
		},
	});
	const setup = await renderPicker(refreshController);
	try {
		await flushTestRenderer(setup, 1);
		await act(async () => {
			cachedCandidates.resolve(candidates);
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
		await refreshStarted.promise;
		await setup.waitForFrame((frame) => frame.includes("gpt-4o"));
		expect(setup.captureCharFrame()).not.toContain("gpt-5.1");

		await act(async () => {
			refresh.resolve({
				candidates: [...candidates, refreshedCandidate],
				failedProviderIds: [],
				refreshedProviderIds: ["openai"],
			});
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
		await setup.waitForFrame((frame) => frame.includes("gpt-5.1"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("gpt-5.1");
		expect(frame).not.toContain("Refresh Known Models");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("cached models stay selectable while the background refresh is pending", async () => {
	const cachedCandidates =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const refresh = Promise.withResolvers<ProviderModelSelectionRefreshResult>();
	const refreshStarted = Promise.withResolvers<void>();
	let selectedModelId: string | undefined;
	const controller = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: () => {
			refreshStarted.resolve();
			return refresh.promise;
		},
		selectProviderModelSelectionCandidate,
	});
	const setup = await renderPicker(controller, [], (model) => {
		selectedModelId = model.modelId;
	});
	try {
		await flushTestRenderer(setup, 1);
		await act(async () => {
			cachedCandidates.resolve(candidates);
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
		await refreshStarted.promise;
		await setup.waitForFrame((frame) => frame.includes("gpt-4o"));

		await act(async () => {
			setup.mockInput.typeText("gpt-4o");
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 2);
		await act(async () => {
			setup.mockInput.pressEnter();
			await Bun.sleep(20);
		});
		expect(selectedModelId).toBe("gpt-4o");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("an unconnected OpenRouter shows neither a refresh error nor false success", async () => {
	const { controller, providers } = createUnconnectedOpenRouterController();
	const setup = await renderPicker(controller);
	try {
		await flushTestRenderer(setup, 5);
		await setup.waitForFrame((frame) => frame.includes("Search models"));
		const frame = setup.captureCharFrame();
		expect(frame).not.toContain("Could not refresh openrouter");
		expect(frame).not.toContain("Model catalogs refreshed.");
	} finally {
		await act(() => setup.renderer.destroy());
		await providers.close();
	}
});

test("background discovery failure identifies provider and keeps cached models", async () => {
	const { controller, providers } = createFailingDiscoveryController();
	const refreshProbe = await providers.refreshModels({
		providerIds: ["openai"],
	});
	expect(refreshProbe.errors.get("openai")?.message).toBe(
		"fixture discovery unavailable"
	);
	const setup = await renderPicker(controller);
	try {
		await flushTestRenderer(setup, 5);
		await setup.waitForFrame((frame) => frame.includes("gpt-4o"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("gpt-4o");
		expect(frame).toContain("Could not refresh openai; showing cached models.");
		const frameLines = frame.split("\n");
		const errorLine = frameLines.find((line) =>
			line.includes("Could not refresh openai;")
		);
		const searchLine = frameLines.find((line) =>
			line.includes("Search models")
		);
		const modelLineIndex = frameLines.findIndex((line) =>
			line.includes("gpt-4o")
		);
		const errorLineIndex = frameLines.findIndex((line) =>
			line.includes("Could not refresh openai;")
		);
		const hintLineIndex = frameLines.findIndex((line) =>
			line.includes("navigate")
		);
		expect(errorLine).toBeDefined();
		expect(searchLine).toBeDefined();
		expect(errorLine?.indexOf("Could not refresh openai;")).toBe(
			searchLine?.indexOf("Search models")
		);
		expect(errorLineIndex).toBeGreaterThan(modelLineIndex);
		expect(errorLineIndex).toBeLessThan(hintLineIndex);
		expect(frame).not.toContain(
			"Known Model refresh failed; the last-known model snapshots were retained."
		);
		expect(frame).not.toContain("Refresh Known Models");
	} finally {
		await act(() => setup.renderer.destroy());
		await providers.close();
	}
});
