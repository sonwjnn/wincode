import { afterEach, describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentId, agentIdSchema } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import { modelCatalog } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { act, useEffect, useRef } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import {
	getActiveModels,
	getModelsForPicker,
} from "@/modules/prompt-settings/ui/model-picker-options";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { ThinkingLevelDialogContent } from "@/modules/prompt-settings/ui/thinking-level-dialog";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { SessionUsageBar } from "@/modules/sessions/ui/components/session-usage-bar";
import type { SessionUsageSummary } from "@/modules/sessions/usage/session-usage";
import { ConfigProvider } from "@/shared/config/config-provider";
import type {
	ConfigRuntime,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	type DialogContextValue,
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
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

test("unavailable Agent pins can be replaced only by an exact available Provider Model", async () => {
	const agentId = agentIdSchema.parse("reviewer");
	const availableModel: ProviderModel = {
		modelId: "replacement-model-v2",
		protocolId: "fixture",
		providerId: "plugin-provider",
	};
	const snapshot = fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {
			agents: {
				reviewer: {
					description: "Reviews changes with a Provider Model.",
					model: "plugin-provider/stale-model-v1",
					role: "primary",
				},
			},
		},
		sourceFor: () => undefined,
		sources: [],
	});
	const config = fromPartial<ConfigRuntime>({
		configStore: { getSnapshot: async () => snapshot },
		homeRoot: "/tmp",
		workspace: "/tmp",
	});
	const connections = fromPartial<Connections>({
		listProviders: async () => [],
	});
	const selected = Promise.withResolvers<{
		agent: AgentId;
		model?: ProviderModelSelection;
	}>();
	function AgentDialogHarness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			dialog.open({
				children: (
					<AgentsDialogContent
						availableProviderModels={[availableModel]}
						connectedProviderIds={new Set()}
						currentAgent={agentId}
						onSelectAgent={(agent, model) =>
							selected.resolve({
								agent,
								...(model === undefined ? {} : { model }),
							})
						}
					/>
				),
				title: "Select Agent",
			});
		}, [dialog]);
		return null;
	}
	const setup = await testRender(
		<ThemeProvider>
			<ConfigProvider value={config}>
				<ToastProvider>
					<ConnectionsProvider connections={connections}>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<DialogProvider>
									<AgentDialogHarness />
								</DialogProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ConnectionsProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	activeSetups.push(setup);
	await flushUi(setup);
	await flushUi(setup);
	await setup.waitForFrame((frame) =>
		frame.includes("choose a replacement model")
	);
	await act(() => setup.mockInput.pressEnter());
	await setup.waitForFrame((frame) => frame.includes("replacement-model-v2"));
	expect(setup.captureCharFrame()).toContain("replacement-model-v2");
	await act(() => setup.mockInput.pressEnter());
	expect(await selected.promise).toEqual({
		agent: agentId,
		model: {
			modelId: modelId("replacement-model-v2"),
			providerId: "plugin-provider",
		},
	});
});

test("a connected Catalog-pinned Agent with no active Host model offers an explicit replacement", async () => {
	const agentId = agentIdSchema.parse("stale-catalog-reviewer");
	const availableModel: ProviderModel = {
		modelId: "gpt-5.6",
		protocolId: "openai-responses",
		providerId: "openai",
	};
	const snapshot = fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {
			agents: {
				"stale-catalog-reviewer": {
					description: "Reviews changes with a stale Catalog pin.",
					model: "openai/gpt-5.6-luna",
					role: "primary",
				},
			},
		},
		sourceFor: () => undefined,
		sources: [],
	});
	const config = fromPartial<ConfigRuntime>({
		configStore: { getSnapshot: async () => snapshot },
		homeRoot: "/tmp",
		workspace: "/tmp",
	});
	const connections = fromPartial<Connections>({
		listProviders: async () => [
			{
				connected: true,
				connectionMethod: "api-key",
				displayName: "OpenAI",
				id: "openai",
				methods: ["api-key"],
			},
		],
	});
	const selected = Promise.withResolvers<{
		agent: AgentId;
		model?: ProviderModelSelection;
	}>();
	function AgentDialogHarness() {
		const dialog = useDialog();
		const opened = useRef(false);
		useEffect(() => {
			if (opened.current) {
				return;
			}
			opened.current = true;
			dialog.open({
				children: (
					<AgentsDialogContent
						availableProviderModels={[availableModel]}
						connectedProviderIds={new Set(["openai"])}
						currentAgent={agentId}
						onSelectAgent={(agent, model) =>
							selected.resolve({
								agent,
								...(model === undefined ? {} : { model }),
							})
						}
					/>
				),
				title: "Select Agent",
			});
		}, [dialog]);
		return null;
	}
	const setup = await testRender(
		<ThemeProvider>
			<ConfigProvider value={config}>
				<ToastProvider>
					<ConnectionsProvider connections={connections}>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<DialogProvider>
									<AgentDialogHarness />
								</DialogProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ConnectionsProvider>
				</ToastProvider>
			</ConfigProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	activeSetups.push(setup);
	await flushUi(setup);
	await flushUi(setup);
	await setup.waitForFrame((frame) =>
		frame.includes("choose a replacement model")
	);
	await act(() => setup.mockInput.pressEnter());
	await setup.waitForFrame((frame) => frame.includes("openai/gpt-5.6"));
	expect(setup.captureCharFrame()).toContain("openai/gpt-5.6");
	await act(() => setup.mockInput.pressEnter());
	expect(await selected.promise).toEqual({
		agent: agentId,
		model: {
			modelId: modelId("gpt-5.6"),
			providerId: "openai",
		},
	});
	expect(snapshot.document.agents).toMatchObject({
		"stale-catalog-reviewer": { model: "openai/gpt-5.6-luna" },
	});
});

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
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWarmingStatus: "idle",
		costUsd: null,
		costCoverage: overrides.costUsd == null ? "unknown" : "complete",
		costedTurns: 0,
		costedUsageEntries: 0,
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

	test("shows cached reads and writes with estimated session cost", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({
					cacheReadTokens: 1200,
					cacheWriteTokens: 100,
					costUsd: 1.2345,
				})}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("cache read 1.2K");
		expect(frame).toContain("write 100");
		expect(frame).toContain("~$1.23");
	});

	test("shows cache warming status and cost without changing context", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({
					cacheWarmingStatus: "scheduled",
					contextPercent: 42,
					contextTokens: 84_000,
					costUsd: 1.25,
				})}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("42%(84K/200K)");
		expect(frame).toContain("cache warming scheduled");
		expect(frame).toContain("~$1.25");
	});

	test("shows an explicit unknown-cost state for measured usage", async () => {
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
		expect(frame).not.toContain("cache read");
		expect(frame).toContain("cost unknown");
	});

	test("qualifies totals that exclude usage with unknown rates", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({ costCoverage: "partial", costUsd: 1.25 })}
			/>
		));

		expect(setup.captureCharFrame()).toContain("~$1.25 (partial)");
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
