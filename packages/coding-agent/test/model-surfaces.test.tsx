import { afterEach, describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentId, agentIdSchema } from "@wincode/agent-core";
import type {
	ProviderCollection,
	ProviderModel,
	ThinkingLevel,
} from "@wincode/ai";
import { act, useEffect, useRef } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { ThinkingLevelDialogContent } from "@/modules/prompt-settings/ui/thinking-level-dialog";
import { createInteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	type ProviderModelSelection,
	UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import { SessionUsageBar } from "@/modules/sessions/ui/components/session-usage-bar";
import type { SessionUsageSummary } from "@/modules/sessions/usage/session-usage";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import {
	type DialogContextValue,
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { modelId } from "./support/identifiers";

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

const pluginProviderRegistration = (pluginId: string) =>
	fromPartial<PluginProviderDescriptor>({
		connect: async () => undefined,
		displayName: pluginId,
		pluginId,
		providerId: "plugin-provider",
		sourceIdentity: `/plugins/${pluginId}.ts`,
	});

const createProviderModelPickerController = ({
	getAvailable,
	getCompositionRevision,
	getHostRegistration,
	getTrustedRegistration,
	getTrustedRuntime,
}: {
	getAvailable: () => Promise<readonly ProviderModel[]>;
	getCompositionRevision: () => number;
	getHostRegistration: () => PluginProviderDescriptor;
	getTrustedRegistration: () => PluginProviderDescriptor;
	getTrustedRuntime: () => object;
}) =>
	createInteractiveProviderController(
		fromPartial<ProviderCollection>({
			getAvailable,
			getConfiguredProviderIds: async () => [],
			getModels: () => [],
			restoreModels: async () => undefined,
		}),
		{
			getCompositionRevision,
			getPluginProviderRegistrations: () => [getHostRegistration()],
			getTrustedPluginProviderRegistrations: () => [getTrustedRegistration()],
			getTrustedPluginProviderRuntime: getTrustedRuntime,
			withSessionWork: async (action) => await action(),
		}
	);

test("Provider Model picker rejects owner A results instead of binding them to owner B", async () => {
	const model: ProviderModel = {
		modelId: "same-model-id",
		protocolId: "fixture",
		providerId: "plugin-provider",
	};
	let trustedRegistration = pluginProviderRegistration("owner-a");
	let hostRegistration = trustedRegistration;
	let trustedRuntime: object = {};
	let compositionRevision = 1;
	let credentialReads = 0;
	let selected: ProviderModelSelection | undefined;
	const controller = createProviderModelPickerController({
		getAvailable: async () => {
			credentialReads += 1;
			return [model];
		},
		getCompositionRevision: () => compositionRevision,
		getHostRegistration: () => hostRegistration,
		getTrustedRegistration: () => trustedRegistration,
		getTrustedRuntime: () => trustedRuntime,
	});
	const setup = await renderDialogSurface(
		<ProviderModelsDialogContent
			controller={controller}
			currentModel={DEFAULT_PROVIDER_MODEL_SELECTION}
			onSelectModel={(_providerModel, selection) => {
				selected = selection;
			}}
		/>
	);

	await setup.waitForFrame((frame) => frame.includes("same-model-id"));
	trustedRegistration = pluginProviderRegistration("owner-b");
	hostRegistration = trustedRegistration;
	trustedRuntime = {};
	compositionRevision += 1;

	await act(() => setup.mockInput.pressEnter());
	await setup.waitForFrame((frame) =>
		frame.includes("Provider Model results are stale")
	);

	expect(selected).toBeUndefined();
	expect(credentialReads).toBe(1);
});

test("built-in Provider Model results expire when the whole composition revision changes", async () => {
	const model: ProviderModel = {
		modelId: "gpt-6-luna",
		protocolId: "fixture",
		providerId: "openai",
	};
	let trustedRegistration = pluginProviderRegistration("owner-a");
	let hostRegistration = trustedRegistration;
	let trustedRuntime: object = {};
	let compositionRevision = 1;
	let selected: ProviderModelSelection | undefined;
	const controller = createProviderModelPickerController({
		getAvailable: async () => [model],
		getCompositionRevision: () => compositionRevision,
		getHostRegistration: () => hostRegistration,
		getTrustedRegistration: () => trustedRegistration,
		getTrustedRuntime: () => trustedRuntime,
	});
	const setup = await renderDialogSurface(
		<ProviderModelsDialogContent
			controller={controller}
			currentModel={DEFAULT_PROVIDER_MODEL_SELECTION}
			onSelectModel={(_providerModel, selection) => {
				selected = selection;
			}}
		/>
	);

	await setup.waitForFrame((frame) => frame.includes("gpt-6-luna"));
	trustedRegistration = pluginProviderRegistration("owner-b");
	hostRegistration = trustedRegistration;
	trustedRuntime = {};
	compositionRevision += 1;
	await act(() => setup.mockInput.pressEnter());
	await setup.waitForFrame((frame) =>
		frame.includes("Provider Model results are stale")
	);

	expect(selected).toBeUndefined();
});

test("Provider Model picker blocks credential reads when trusted and Host snapshots differ", async () => {
	const model: ProviderModel = {
		modelId: "same-model-id",
		protocolId: "fixture",
		providerId: "plugin-provider",
	};
	const trustedRegistration = pluginProviderRegistration("owner-a");
	const hostRegistration = pluginProviderRegistration("owner-b");
	let credentialReads = 0;
	const controller = createProviderModelPickerController({
		getAvailable: async () => {
			credentialReads += 1;
			return [model];
		},
		getCompositionRevision: () => 1,
		getHostRegistration: () => hostRegistration,
		getTrustedRegistration: () => trustedRegistration,
		getTrustedRuntime: () => ({}),
	});
	const setup = await renderDialogSurface(
		<ProviderModelsDialogContent
			controller={controller}
			currentModel={DEFAULT_PROVIDER_MODEL_SELECTION}
			onSelectModel={() => undefined}
		/>
	);

	await setup.waitForFrame((frame) =>
		frame
			.replace(/\s+/gu, " ")
			.includes(UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE)
	);
	expect(credentialReads).toBe(0);
});

test("Agent selection offers an exact available replacement without changing the stored pin", async () => {
	const agentId = agentIdSchema.parse("reviewer");
	const availableModel: ProviderModel = {
		modelId: "replacement-model-v2",
		protocolId: "fixture",
		providerId: "plugin-provider",
	};
	const config = {
		configStore: createConfigStore({
			homeRoot: "/tmp",
			trustedProjectRoots: [],
			fs: {
				readFile: async (file) => {
					if (file !== "/tmp/.wincode/settings.json") {
						throw Object.assign(new Error("missing"), { code: "ENOENT" });
					}
					return JSON.stringify({
						agents: {
							reviewer: {
								description: "Reviews changes with a Provider Model.",
								model: "plugin-provider/stale-model-v1",
								role: "primary",
							},
						},
					});
				},
			},
		}),
		homeRoot: "/tmp",
		workspace: "/tmp",
	};
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
					<AgentRegistryProvider>
						<KeyboardLayerProvider>
							<DialogProvider>
								<AgentDialogHarness />
							</DialogProvider>
						</KeyboardLayerProvider>
					</AgentRegistryProvider>
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
	await act(() => setup.mockInput.pressEnter());

	expect(await selected.promise).toEqual({
		agent: agentId,
		model: {
			modelId: modelId("replacement-model-v2"),
			providerId: "plugin-provider",
		},
	});
	expect(
		(await config.configStore.getSnapshot(config.workspace)).document.agents
	).toMatchObject({
		reviewer: { model: "plugin-provider/stale-model-v1" },
	});
});

const supportedModel: ProviderModel = {
	modelId: "reasoning-model",
	protocolId: "fixture",
	providerId: "fixture",
	reasoningEfforts: ["minimal", "low", "medium", "xhigh"],
};

const renderThinkingLevels = async (
	currentThinkingLevel: ThinkingLevel | undefined,
	thinkingLevels: readonly ThinkingLevel[] = [
		"minimal",
		"low",
		"medium",
		"xhigh",
	]
) =>
	renderSurfaces(() => (
		<ThinkingLevelDialogContent
			currentThinkingLevel={currentThinkingLevel}
			onSelectThinkingLevel={() => undefined}
			thinkingLevels={thinkingLevels}
		/>
	));

test("thinking selection renders only levels declared by the Provider Model", async () => {
	const setup = await renderThinkingLevels(undefined);
	await setup.waitForFrame((frame) => frame.includes("Extra high"));

	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("Provider default");
	expect(frame).toContain("Minimal");
	expect(frame).toContain("Low");
	expect(frame).toContain("Medium");
	expect(frame).toContain("Extra high");
	expect(frame).not.toContain("High");
	expect(supportedModel.reasoningEfforts).toEqual([
		"minimal",
		"low",
		"medium",
		"xhigh",
	]);
});

test("Off remains an explicit selectable ThinkingLevel", async () => {
	let selectedLevel: ThinkingLevel | undefined;
	const setup = await renderDialogSurface(
		<ThinkingLevelDialogContent
			currentThinkingLevel="low"
			onSelectThinkingLevel={(level) => {
				selectedLevel = level;
			}}
			thinkingLevels={["off", "low"]}
		/>
	);

	await act(async () => setup.mockInput.typeText("off"));
	await flushUi(setup);
	await act(() => setup.mockInput.pressEnter());
	await flushUi(setup);

	expect(selectedLevel).toBe("off");
});

test("an unsupported Provider Model exposes no synthetic default level", async () => {
	const setup = await renderThinkingLevels(undefined, []);
	await setup.waitForFrame((frame) =>
		frame.includes("No thinking levels available")
	);

	const frame = setup.captureCharFrame();
	expect(frame).not.toContain("Provider default");
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

describe("session usage bar", () => {
	const summary = (
		overrides: Partial<SessionUsageSummary>
	): SessionUsageSummary => ({
		contextLimit: 200_000,
		contextPercent: 42,
		contextTokens: 84_000,
		contextSource: "measured",
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
				summary={summary({
					contextLimit: 1_000_000,
					contextPercent: 42,
					contextTokens: 420_000,
					costUsd: 1.2345,
				})}
			/>
		));

		const frame = setup.captureCharFrame();
		expect(frame).toContain("42.0%/1m");
		// The tilde is the honesty marker: these are published rates, not a bill.
		expect(frame).toContain("~$1.23");
	});

	test("displays context usage above 100% when it exceeds the model limit", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({
					contextLimit: 200_000,
					contextPercent: 200,
					contextTokens: 400_000,
				})}
			/>
		));

		expect(setup.captureCharFrame()).toContain("200.0%/200k");
	});

	test.each([
		"estimated",
		"mixed",
	] as const)("marks %s context as approximate rather than a provider measurement", async (contextSource) => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar summary={summary({ contextSource })} />
		));
		expect(setup.captureCharFrame()).toContain("~42.0%/200k");
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
		expect(frame).toContain("42.0%/200k");
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
		expect(frame).toContain("29.0%/272k");
		expect(frame).not.toContain("cache read");
		expect(frame).toContain("cost unknown");
	});

	test("marks context as auto only when auto-compact is enabled", async () => {
		const context = summary({
			contextLimit: 272_000,
			contextPercent: 94,
			contextTokens: 255_952,
		});
		const manualSetup = await renderSurfaces(() => (
			<SessionUsageBar summary={context} />
		));
		const autoSetup = await renderSurfaces(() => (
			<SessionUsageBar autoCompact summary={context} />
		));

		expect(manualSetup.captureCharFrame()).toContain("94.1%/272k");
		expect(manualSetup.captureCharFrame()).not.toContain("(auto)");
		expect(autoSetup.captureCharFrame()).toContain("94.1%/272k (auto)");
	});

	test("qualifies totals that exclude usage with unknown rates", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar
				summary={summary({ costCoverage: "partial", costUsd: 1.25 })}
			/>
		));

		expect(setup.captureCharFrame()).toContain("~$1.25 (partial)");
	});

	test("shows the 272k fallback when the current Provider Model has no context metadata", async () => {
		const setup = await renderSurfaces(() => (
			<SessionUsageBar summary={summary({ contextLimit: 272_000 })} />
		));

		expect(setup.captureCharFrame()).toContain("30.9%/272k");
	});
});
