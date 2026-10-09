import { afterEach, describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { modelCatalog } from "@wincode/ai/models";
import { act, useEffect, useRef } from "react";
import {
	getActiveModels,
	getModelsForPicker,
} from "@/modules/prompt-settings/ui/model-picker-options";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { ThinkingLevelDialogContent } from "@/modules/prompt-settings/ui/thinking-level-dialog";
import { SessionUsageBar } from "@/modules/sessions/ui/components/session-usage-bar";
import type { SessionUsageSummary } from "@/modules/sessions/usage/session-usage";
import {
	type DialogContextValue,
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { modelId } from "./support/identifiers";

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

const renderDialogSurface = async (content: React.ReactNode) => {
	function Harness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			dialog.open({ children: content, title: "Select Thinking Level" });
		}, [dialog]);
		return null;
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
					modelId: modelId(active.id),
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

	test("preserves one blank row between provider groups", async () => {
		const openai = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "openai" && entry.id === "gpt-5.6-luna"
		);
		const anthropic = modelCatalog.find(
			(entry) => entry.connectionProviderId === "anthropic"
		);
		if (!(openai && anthropic)) {
			throw new Error("fixture models missing");
		}
		const models = [
			{ ...openai, displayName: "OpenAI spacing sentinel" },
			{ ...anthropic, displayName: "Anthropic spacing sentinel" },
		];
		const setup = await renderSurfaces(() => (
			<ModelsDialogContent
				models={models}
				onSelectModel={() => undefined}
				recentSelections={[]}
			/>
		));
		await setup.waitForFrame(
			(frame) =>
				frame.includes("OpenAI spacing sentinel") &&
				frame.includes("Anthropic spacing sentinel")
		);

		const lines = setup.captureCharFrame().split("\n");
		const modelRows = [
			lines.findIndex((line) => line.includes("OpenAI spacing sentinel")),
			lines.findIndex((line) => line.includes("Anthropic spacing sentinel")),
		].sort((left, right) => left - right);
		const [firstModelRow, secondModelRow] = modelRows;
		if (firstModelRow === undefined || secondModelRow === undefined) {
			throw new Error("provider model rows missing");
		}
		expect(secondModelRow - firstModelRow).toBe(3);
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
			modelId: modelId(retired.id),
			providerId: retired.connectionProviderId,
		};
		const selectable = getModelsForPicker([active, retired], currentModel);

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

describe("Thinking level picker", () => {
	test("renders only model-supported named levels", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "opencode-go" &&
				entry.id === "qwen3.8-flash"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		const setup = await renderSurfaces(() => (
			<ThinkingLevelDialogContent
				currentModel={model}
				currentThinkingLevel={undefined}
				onSelectDefault={() => undefined}
				onSelectThinkingLevel={() => undefined}
			/>
		));

		await setup.waitForFrame((frame) => frame.includes("Extra high"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Provider default");
		expect(frame).toContain("Low");
		expect(frame).toContain("Medium");
		expect(frame).toContain("Extra high");
		expect(frame).not.toContain("Minimal");
		expect(frame).not.toContain("High");
	});
	test("selecting provider default clears an active ThinkingLevel", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "opencode-go" &&
				entry.id === "qwen3.8-flash"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		let cleared = false;
		const setup = await renderDialogSurface(
			<ThinkingLevelDialogContent
				currentModel={model}
				currentThinkingLevel="low"
				onSelectDefault={() => {
					cleared = true;
				}}
				onSelectThinkingLevel={() => undefined}
			/>
		);

		await act(async () => setup.mockInput.typeText("default"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressEnter());
		await flushUi(setup);

		expect(cleared).toBe(true);
	});

	test("maps every positive level to enabled reasoning for a toggle-only model", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "opencode-go" &&
				entry.id === "qwen3.7-max"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		const setup = await renderSurfaces(() => (
			<ThinkingLevelDialogContent
				currentModel={model}
				currentThinkingLevel={undefined}
				onSelectDefault={() => undefined}
				onSelectThinkingLevel={() => undefined}
			/>
		));
		await setup.waitForFrame((frame) => frame.includes("Provider default"));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("Provider default");
		expect(frame).toContain("Off");
		expect(frame).toContain("Minimal");
		expect(frame).toContain("Low");
		expect(frame).toContain("Medium");
		expect(frame).toContain("High");
		expect(frame).not.toContain("Extra high");
	});

	test("keeps provider default as the only choice for a budget-only model", async () => {
		const model = modelCatalog.find(
			(entry) =>
				entry.connectionProviderId === "anthropic" &&
				entry.id === "claude-sonnet-4-5"
		);
		if (!model) {
			throw new Error("fixture model missing");
		}
		const setup = await renderSurfaces(() => (
			<ThinkingLevelDialogContent
				currentModel={model}
				currentThinkingLevel={undefined}
				onSelectDefault={() => undefined}
				onSelectThinkingLevel={() => undefined}
			/>
		));

		await setup.waitForFrame((frame) => frame.includes("Provider default"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Provider default");
		for (const unsupportedLevel of [
			"Off",
			"Minimal",
			"Low",
			"Medium",
			"High",
			"Extra high",
		]) {
			expect(frame).not.toContain(unsupportedLevel);
		}
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

	test("shows used context within the limit and marks estimated cost", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({ contextLimit: 1_000_000, costUsd: 1.2345 })}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("42%(84K/1.0M)");
		// The tilde is the honesty marker: these are published rates, not a bill.
		expect(frame).toContain("~$1.23");
	});

	test("shows the requested used/limit context and omits unknown cost", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({
					contextLimit: 272_000,
					contextPercent: 29,
					contextTokens: 79_000,
				})}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("29%(79K/272K)");
		expect(frame).not.toContain("$");
	});

	test("shows used tokens when max context is unavailable", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({ contextLimit: null, contextPercent: null })}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("84K");
		expect(frame).not.toContain("42%");
	});
});
