import { afterEach, describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { modelCatalog } from "@wincode/ai/models";
import { act } from "react";
import {
	getActiveModels,
	getModelsForPicker,
} from "@/modules/commands/adapters/models-adapter";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { VariantsDialogContent } from "@/modules/prompt-settings/ui/variants-dialog";
import { SessionUsageBar } from "@/modules/sessions/ui/components/session-usage-bar";
import type { SessionUsageSummary } from "@/modules/sessions/usage/session-usage";
import {
	type DialogContextValue,
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";

/**
 * Renders the two surfaces this change moved: the model picker and the usage
 * bar. Both are asserted through their rendered text, because the failure
 * these guard against — a picker offering a model the runtime refuses, or a
 * cost the user never sees — is only visible in what the user reads.
 */
type RenderSetup = TestRendererSetup;
const activeSetups: RenderSetup[] = [];
afterEach(() => {
	for (const setup of activeSetups) {
		act(() => setup.renderer.destroy());
	}
	activeSetups.length = 0;
});
const flushUi = async (setup: RenderSetup): Promise<void> => {
	await act(async () => {
		await setup.renderOnce();
		await setup.waitForVisualIdle();
	});
};

const renderSurfaces = async (
	content: (dialog: DialogContextValue | null) => React.ReactNode
) => {
	function Harness() {
		const dialog = useDialog();
		return <>{content(dialog)}</>;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<Harness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	activeSetups.push(setup);
	await flushUi(setup);
	return setup;
};

describe("model picker", () => {
	test("filters retired catalog entries before rendering", async () => {
		const active = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "openai" && entry.id === "gpt-5.6-luna"
		);
		const anthropic = modelCatalog.find(
			(entry) => entry.connectionProviderId === "anthropic"
		);
		if (!(active && anthropic)) {
			throw new Error("fixture model missing");
		}
		const retired = {
			...active,
			displayName: "Retired fixture",
			id: "retired-fixture",
			lifecycle: "retired" as const,
		};
		const selectable = getActiveModels([active, retired, anthropic]);
		expect(selectable).toEqual([active, anthropic]);

		const setup = await renderSurfaces(() => (
			<ModelsDialogContent
				currentModel={{
					modelId: active.id,
					providerId: active.connectionProviderId,
				}}
				models={selectable}
				onSelectModel={() => undefined}
				recentSelections={[]}
			/>
		));
		await setup.waitForFrame((frame) => frame.includes("GPT-5.6 Luna"));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("GPT-5.6 Luna");
		expect(frame).not.toContain("Retired fixture");
	});
	test("keeps a retired current selection visible", async () => {
		const active = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "openai" && entry.id === "gpt-5.6-luna"
		);
		if (!active) {
			throw new Error("fixture model missing");
		}
		const retired = {
			...active,
			displayName: "Retired fixture",
			id: "retired-fixture",
			lifecycle: "retired" as const,
		};
		const currentModel = {
			modelId: retired.id,
			providerId: retired.connectionProviderId,
		};
		const selectable = getModelsForPicker([active, retired], currentModel);
		expect(selectable).toEqual([retired, active]);

		const setup = await renderSurfaces(() => (
			<ModelsDialogContent
				currentModel={currentModel}
				models={selectable}
				onSelectModel={() => undefined}
				recentSelections={[]}
			/>
		));
		await setup.waitForFrame((frame) => frame.includes("Retired fixture"));

		expect(setup.captureCharFrame()).toContain("Retired fixture");
	});
});

describe("variants dialog", () => {
	test("renders the independently specified variant options", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "openai" && entry.id === "gpt-5.6-luna"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		const setup = await renderSurfaces(() => (
			<VariantsDialogContent
				currentModel={model}
				currentVariant={undefined}
				onSelectVariant={() => undefined}
			/>
		));

		// These labels are the catalog contract for this fixture, not a second
		// call to the helper that the component uses to build its options.
		const expectedVariants = [
			"default",
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		];
		await setup.waitForFrame((frame) => frame.includes("xhigh"));
		let frame = setup.captureCharFrame();
		expect(frame).toContain("default");
		for (const variant of expectedVariants.slice(1, -1)) {
			expect(frame).toContain(`\n    ${variant}`);
		}
		await act(async () => {
			await setup.mockInput.typeText("max");
		});
		await flushUi(setup);
		frame = setup.captureCharFrame();
		expect(frame).toContain("\n    max");
	});

	test("reports an empty list for a model with no reasoning control", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "opencode-go" && entry.id === "kimi-k2.6"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		const setup = await renderSurfaces(() => (
			<VariantsDialogContent
				currentModel={model}
				currentVariant={undefined}
				onSelectVariant={() => undefined}
			/>
		));

		// Reasoning is always on upstream with nothing to configure, so the
		// dialog says so rather than offering a level that does nothing.
		expect(setup.captureCharFrame()).toContain("No variants available");
	});
});

describe("session usage bar", () => {
	const summary = (
		overrides: Partial<SessionUsageSummary>
	): SessionUsageSummary => ({
		contextLimit: 200_000,
		contextPercent: 42,
		contextTokens: 84_000,
		costUsd: null,
		costedTurns: 0,
		...overrides,
	});

	test("shows context and marks an estimated cost as an estimate", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar summary={summary({ costUsd: 1.2345 })} />
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("84K");
		expect(frame).toContain("42%");
		// The tilde is the honesty marker: these are published rates, not a bill.
		expect(frame).toContain("~$1.23");
	});

	test("omits the cost entirely when no rate is known", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar summary={summary({})} />
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("84K");
		expect(frame).not.toContain("$");
	});
});
