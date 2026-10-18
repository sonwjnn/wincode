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
		refreshProviderModelSelectionCandidates: async () => candidates,
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
	const refresh =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const retryRefresh =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	let refreshCalls = 0;
	const refreshController = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: () => {
			refreshCalls += 1;
			return refreshCalls === 1 ? refresh.promise : retryRefresh.promise;
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
		await setup.waitForFrame(
			(frame) =>
				frame.includes("gpt-4o") && frame.includes("Refreshing Known Models…")
		);
		expect(refreshCalls).toBe(1);
		expect(setup.captureCharFrame()).not.toContain("gpt-5.1");

		await act(async () => {
			refresh.resolve([...candidates, refreshedCandidate]);
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
		await setup.waitForFrame((frame) => frame.includes("gpt-5.1"));
		expect(setup.captureCharFrame()).toContain("Refresh Known Models");

		await act(async () => {
			setup.mockInput.typeText("refresh");
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 2);
		await act(async () => {
			setup.mockInput.pressEnter();
			await Bun.sleep(20);
		});
		expect(refreshCalls).toBe(2);
		await act(async () => {
			retryRefresh.resolve([...candidates, refreshedCandidate]);
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("cached models stay selectable while the background refresh is pending", async () => {
	const cachedCandidates =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const refresh =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	let selectedModelId: string | undefined;
	const controller = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: () => refresh.promise,
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
		await setup.waitForFrame(
			(frame) =>
				frame.includes("Refreshing Known Models…") && frame.includes("gpt-4o")
		);

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

test("preserves last-known models and reports an automatic refresh failure", async () => {
	const cachedCandidates =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	const refresh =
		Promise.withResolvers<readonly ProviderModelSelectionCandidate[]>();
	let refreshCalls = 0;
	const failedRefreshController = fromPartial<InteractiveProviderController>({
		getAvailableProviderModelSelectionCandidates: () =>
			cachedCandidates.promise,
		refreshProviderModelSelectionCandidates: () => {
			refreshCalls += 1;
			return refresh.promise;
		},
	});
	const setup = await renderPicker(failedRefreshController);
	try {
		await flushTestRenderer(setup, 1);
		await act(async () => {
			cachedCandidates.resolve(candidates);
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 3);
		await setup.waitForFrame((frame) =>
			frame.includes("Refreshing Known Models…")
		);
		await act(async () => {
			refresh.reject(new Error("provider catalog unreachable"));
			await Bun.sleep(20);
		});
		await flushTestRenderer(setup, 2);
		await setup.waitForFrame((frame) =>
			frame.includes("provider catalog unreachable")
		);
		const frame = setup.captureCharFrame();
		expect(refreshCalls).toBe(1);
		expect(frame).toContain("gpt-4o");
		expect(frame).toContain("Refresh Known Models");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
