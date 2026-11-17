import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CapturedFrame,
	type InputRenderable,
	RGBA,
	type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { agentIdSchema, toModelId } from "@wincode/agent-core";
import type {
	PluginAutocompleteProviderFactory,
	PluginEditorComponent,
	PluginEditorContext,
	PluginFactory,
	PluginUIContributionResult,
	PluginUICustomBounds,
	PluginUICustomComponent,
	PluginUICustomContext,
	PluginUICustomPresentationMode,
	PluginUIUpdate,
	SessionSdk,
	SessionSdkEvent,
	SessionSdkHandle,
} from "@wincode/coding-agent";
import { LocalStyleProvider } from "@wincode/tui";
import { act, useEffect, useRef, useState } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import {
	type CommandControllerFactory,
	createCommandController,
} from "@/modules/commands/command-controller";
import { CommandControllerFactoryProvider } from "@/modules/commands/command-controller-context";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createPluginTools } from "@/modules/plugins/tools";
import type { PluginUIHost } from "@/modules/plugins/ui/plugin-ui-host";
import {
	PluginEditorSlot,
	PluginUIContributionStatus,
	PluginUICustomPresentation,
	PluginUIFooter,
	PluginUIHeader,
	PluginUIHostProvider,
	usePluginUIHost,
} from "@/modules/plugins/ui/plugin-ui-host";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionMessage } from "@/modules/sessions/message";
import { ChatTextArea } from "@/modules/sessions/ui/components/chat-text-area";
import { BotMessageContent } from "@/modules/sessions/ui/messages/bot-message";
import {
	SettingsRegistryProvider,
	useSettingsOperations,
} from "@/modules/settings";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import { toSessionId } from "@/shared/identifiers";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import {
	ThemeProvider,
	useTheme,
} from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import customEditorPlugin from "../../examples/custom-editor-plugin";
import pluginUIContributionsPlugin from "../../examples/plugin-ui-contributions-plugin";
import pluginUiFixture from "../fixtures/plugin-ui-fixture";
import pluginUiOtherFixture from "../fixtures/plugin-ui-other-fixture";
import { testRenderWithClipboard } from "../support/clipboard";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
	type FakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { toolCallId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

const sessionMessagesFromTranscript = (
	transcript: readonly object[]
): readonly SessionMessage[] => transcript as readonly SessionMessage[];

const contributionRenderParts: SessionMessage["parts"] = [
	{ text: "private reasoning text", type: "reasoning" },
	{
		input: { command: "printf contribution output" },
		output: {
			exitCode: 0,
			output: Array.from({ length: 12 }, (_, index) =>
				index === 11 ? "final expanded output line" : `output line ${index + 1}`
			).join("\n"),
		},
		state: "output-available",
		toolCallId: toolCallId("plugin-ui-expanded-shell"),
		type: "tool-shell",
	},
];

const WrappedPluginEditor: PluginEditorComponent = ({
	defaultEditor,
	theme,
	width,
}) => (
	<box flexDirection="column">
		<text>{`Wrapped host editor · ${theme.name} · ${width}`}</text>
		{defaultEditor}
	</box>
);

const ReplacementPluginEditor: PluginEditorComponent = ({ defaultEditor }) => (
	<box flexDirection="column">
		<text>Replacement host editor</text>
		{defaultEditor}
	</box>
);

const LocalNavigationPluginEditor: PluginEditorComponent = ({
	cursorOffset,
}) => {
	const localTextAreaRef = useRef<TextareaRenderable>(null);
	const [cursorLine, setCursorLine] = useState(1);
	useEffect(() => {
		localTextAreaRef.current?.focus();
	}, []);
	return (
		<box flexDirection="column">
			<textarea
				focused
				height={2}
				initialValue={"first line\nsecond line"}
				onCursorChange={({ line }) => setCursorLine(line)}
				ref={localTextAreaRef}
			/>
			<text>{`Local editor line ${cursorLine}; host cursor ${cursorOffset}`}</text>
		</box>
	);
};

const textFromSessionTranscript = (transcript: readonly object[]): string =>
	sessionMessagesFromTranscript(transcript)
		.flatMap(({ parts }) =>
			parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
		)
		.join(" ");

const getRenderedBackgroundBounds = (
	frame: CapturedFrame,
	background: RGBA
):
	| Readonly<{
			cellCount: number;
			height: number;
			left: number;
			top: number;
			width: number;
	  }>
	| undefined => {
	let cellCount = 0;
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const [row, line] of frame.lines.entries()) {
		let column = 0;
		for (const span of line.spans) {
			if (span.bg.equals(background)) {
				cellCount += span.width;
				left = Math.min(left, column);
				top = Math.min(top, row);
				right = Math.max(right, column + span.width - 1);
				bottom = Math.max(bottom, row);
			}
			column += span.width;
		}
	}
	if (cellCount === 0) {
		return;
	}
	return {
		cellCount,
		height: bottom - top + 1,
		left,
		top,
		width: right - left + 1,
	};
};

type OpenedPluginUITestAgentSession = Readonly<{
	dispose: () => Promise<void>;
	handle: SessionSdkHandle;
}>;

type CustomUIState = {
	asyncFactoryResult: Promise<PluginUICustomComponent<string>>;
	factoryCalls: number;
	factoryStarted: Promise<void>;
	lastComponentDimensions:
		| Readonly<{ height: number; width: number }>
		| undefined;
	lastContext: PluginUICustomContext<string> | undefined;
	lastFactoryBounds: PluginUICustomBounds | undefined;
	lastPresentationState:
		| Readonly<{
				bounds: PluginUICustomBounds;
				focused: boolean;
				hidden: boolean;
				presentation: PluginUICustomPresentationMode;
		  }>
		| undefined;
	resolveAsyncFactory: (component: PluginUICustomComponent<string>) => void;
	throwComponent: boolean;
};

type PluginKeyboardState = {
	componentKeys: string[];
	consumingInputs: string[];
	inputEvents: string[];
	localInputs: string[];
	shortcutCalls: number;
	shortcutContexts: string[];
	shortcutThemeCount: number;
	stopInput: (() => void) | undefined;
};

type OtherPluginKeyboardState = {
	inputEvents: string[];
	shortcutCalls: number;
	stopInput: (() => void) | undefined;
};

function HostMetaWAction({
	onAction,
}: Readonly<{
	onAction: (key: Readonly<{ meta: boolean; option: boolean }>) => void;
}>) {
	const { isTopLayer } = useKeyboardLayer();
	useKeyboard((key) => {
		if (isTopLayer("base") && (key.option || key.meta) && key.name === "w") {
			key.preventDefault();
			onAction({ meta: key.meta, option: key.option });
		}
	});
	return null;
}

type RealComposerState = {
	context: PluginEditorContext | undefined;
	submittedTexts: string[];
};

const completionPrefixPattern = /\S*$/u;

const realComposerCommandControllerFactory: CommandControllerFactory = {
	create: () =>
		createCommandController({
			customCommands: [],
			discoverCustomCommands: async () => [],
			discoverSkills: async () => [],
			executeCommand: () => undefined,
			onError: () => undefined,
			skills: [],
		}),
};
const pluginUiTestEnvironment = async (
	executionMode: ExecutionMode = "interactive",
	testRendererOptions: Readonly<{
		height?: number;
		kittyKeyboard?: boolean;
		width?: number;
	}> = {},
	bindPluginUIHostInEditor = false,
	additionalPlugins: readonly Readonly<{
		factory: PluginFactory;
		id: string;
	}>[] = [],
	hostMetaWAction?: (key: Readonly<{ meta: boolean; option: boolean }>) => void,
	showHostHeader = false,
	useRealComposer = false
) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-plugin-ui-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const sessionId = `plugin-ui-${crypto.randomUUID()}`;
	const configStore = createConfigStore({
		homeRoot: root,
		trustedProjectRoots: [workspace],
	});
	const runtime = await loadPlugins({
		bundledPlugins: [
			{ factory: pluginUiFixture, id: "plugin_ui_fixture" },
			{
				factory: pluginUiOtherFixture,
				id: "plugin_ui_other_fixture",
			},
			{ factory: customEditorPlugin, id: "custom_editor" },
			{
				factory: pluginUIContributionsPlugin,
				id: "issue_tracker_ui",
			},
			...additionalPlugins,
		],
		cliPaths: [],
		config: {
			configStore,
			cwd: workspace,
			homeRoot: root,
			trustedProjectRoots: [workspace],
			workspace,
		},
		userDataDir: root,
	});
	let pluginUIHost: PluginUIHost | undefined;
	const uiUpdates: PluginUIUpdate[] = [];
	let isTopLayer: (id: string) => boolean = () => false;
	const transcriptState: {
		advance: () => void;
		setHideThinking: () => Promise<void>;
		showContributionMessage: () => void;
		showSessionTranscript: (transcript: readonly object[]) => void;
	} = {
		advance: () => undefined,
		setHideThinking: async () => undefined,
		showContributionMessage: () => undefined,
		showSessionTranscript: () => undefined,
	};
	const customEditorState: { setMounted: (mounted: boolean) => void } = {
		setMounted: () => undefined,
	};
	const realComposerState: RealComposerState = {
		context: undefined,
		submittedTexts: [],
	};
	const realComposerEditor: PluginEditorComponent = (context) => {
		realComposerState.context = context;
		return (
			<box flexDirection="column">
				<text>{`Real composer theme: ${context.theme.name}`}</text>
				{context.defaultEditor}
			</box>
		);
	};
	function CapturePluginUIHost() {
		pluginUIHost = usePluginUIHost();
		isTopLayer = useKeyboardLayer().isTopLayer;
		return null;
	}
	function ContributionMessage() {
		const settingsOperations = useSettingsOperations();
		transcriptState.setHideThinking = async () => {
			await settingsOperations.setValue("display.hideThinking", true);
		};
		return (
			<BotMessageContent
				parts={contributionRenderParts}
				sessionId={sessionId}
			/>
		);
	}
	function TestTranscript() {
		const [revision, setRevision] = useState(0);
		const [sessionTranscript, setSessionTranscript] = useState<string>();
		const [showContributionMessage, setShowContributionMessage] =
			useState(false);
		transcriptState.advance = () => setRevision((current) => current + 1);
		transcriptState.showContributionMessage = () =>
			setShowContributionMessage(true);
		transcriptState.showSessionTranscript = (transcript) =>
			setSessionTranscript(textFromSessionTranscript(transcript));
		return (
			<>
				<text>
					{sessionTranscript ?? `Plugin UI host fixture · update ${revision}`}
				</text>
				{showContributionMessage ? (
					<ConfigProvider
						value={{
							configStore,
							cwd: workspace,
							homeRoot: root,
							trustedProjectRoots: [workspace],
							workspace,
						}}
					>
						<SettingsRegistryProvider>
							<ContributionMessage />
						</SettingsRegistryProvider>
					</ConfigProvider>
				) : null}
			</>
		);
	}
	function FixtureComposer() {
		const inputRef = useRef<InputRenderable>(null);
		const [value, setValue] = useState("");
		const { isTopLayer } = useKeyboardLayer();
		const host = usePluginUIHost();
		const currentTheme = useTheme().currentTheme;
		const dimensions = useTerminalDimensions();
		useEffect(
			() =>
				host.bindComposer(sessionId, {
					getText: () => inputRef.current?.value ?? "",
					setText: (text) => {
						if (inputRef.current === null) {
							return false;
						}
						inputRef.current.value = text;
						setValue(text);
						return true;
					},
					pasteText: (text) => {
						const input = inputRef.current;
						if (input === null) {
							return false;
						}
						input.insertText(text);
						setValue(input.value);
						return true;
					},
				}),
			[host]
		);
		const defaultEditor = (
			<input
				focused={isTopLayer("base")}
				onContentChange={() => setValue(inputRef.current?.value ?? "")}
				ref={inputRef}
			/>
		);
		const editorContext: PluginEditorContext = {
			cursorOffset: value.length,
			defaultEditor,
			height: dimensions.height,
			keybindings: CHAT_TEXT_AREA_KEY_BINDINGS,
			nextPrompt: () => false,
			paste: (text) => host.getComposer(sessionId)?.pasteText(text) ?? false,
			previousPrompt: () => false,
			setText: (text) => {
				const input = inputRef.current;
				if (input !== null) {
					input.value = text;
				}
				setValue(text);
			},
			submit: async () => undefined,
			text: value,
			theme: currentTheme,
			width: dimensions.width,
		};
		return (
			<box flexDirection="column">
				<text>Fixture composer</text>
				<PluginEditorSlot context={editorContext} sessionId={sessionId} />
				<text>{value}</text>
			</box>
		);
	}
	function RealComposer() {
		return (
			<ConfigProvider value={{ configStore, homeRoot: root, workspace }}>
				<SettingsRegistryProvider>
					<AgentRegistryProvider>
						<PromptConfigProvider>
							<CommandControllerFactoryProvider
								factory={realComposerCommandControllerFactory}
							>
								<ChatTextArea
									id="plugin-ui-real-composer"
									onSubmit={({ text }) => {
										realComposerState.submittedTexts.push(text);
										return true;
									}}
									sessionId={sessionId}
									sessionPromptHistory={[
										{ files: [], text: "real composer history" },
									]}
								/>
							</CommandControllerFactoryProvider>
						</PromptConfigProvider>
					</AgentRegistryProvider>
				</SettingsRegistryProvider>
			</ConfigProvider>
		);
	}
	function Composer() {
		return useRealComposer ? <RealComposer /> : <FixtureComposer />;
	}
	function ThemeProbe({ label }: Readonly<{ label: string }>) {
		const { colors, currentTheme } = useTheme();
		return <text>{`${label}:${currentTheme.name}:${colors.primary}`}</text>;
	}
	function CustomEditorRegion() {
		const [mounted, setMounted] = useState(true);
		customEditorState.setMounted = setMounted;
		if (!mounted) {
			return <Composer />;
		}
		return (
			<>
				<PluginUIContributionStatus sessionId={sessionId} />
				<PluginUICustomPresentation
					{...(bindPluginUIHostInEditor ? { pluginRuntime: runtime } : {})}
					sessionId={sessionId}
				>
					<Composer />
				</PluginUICustomPresentation>
			</>
		);
	}
	const openAgentSession = async (
		recorder: FakeProviderRecorder
	): Promise<OpenedPluginUITestAgentSession> => {
		const services = await openSessionServices({
			policy: {
				cwd: workspace,
				databasePath: path.join(root, "agent-session.sqlite"),
				workspace,
			},
			sources: {
				configRuntime: () => ({
					configStore,
					cwd: workspace,
					homeRoot: root,
					trustedProjectRoots: [workspace],
					workspace,
				}),
				createProviderCollection: () => createFakeProviderCollection(recorder),
				pluginRuntime: () => runtime,
			},
		});
		let handle: SessionSdkHandle | undefined;
		let agentSdk: SessionSdk | undefined;
		try {
			const model = {
				modelId: toModelId("gpt-5.6-luna"),
				providerId: "openai",
			};
			const agentSessionId = toSessionId(sessionId);
			agentSdk = await services.sessionSdk.createSessionRuntime({
				pluginFactories: [
					{ factory: pluginUiFixture, id: "plugin_ui_fixture" },
				],
				projectTrust: "trust",
			});
			await agentSdk.createEmptySession({
				model,
				sessionId: agentSessionId,
			});
			handle = await agentSdk.openSession(agentSessionId, {
				autoContinue: false,
				view: true,
			});
			return {
				dispose: async () => {
					await handle?.dispose();
					await agentSdk?.dispose();
					await services.shutdown();
				},
				handle,
			};
		} catch (error) {
			await handle?.dispose();
			await agentSdk?.dispose();
			await services.shutdown();
			throw error;
		}
	};
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName="opencode">
			<ToastProvider>
				<KeyboardLayerProvider>
					<DialogProvider>
						<PluginUIHostProvider onUpdate={(update) => uiUpdates.push(update)}>
							<CapturePluginUIHost />
							{hostMetaWAction === undefined ? null : (
								<HostMetaWAction onAction={hostMetaWAction} />
							)}
							{showHostHeader ? (
								<PluginUIHeader>
									<text>Host default header</text>
								</PluginUIHeader>
							) : null}
							<TestTranscript />
							<CustomEditorRegion />
							<ThemeProbe label="global" />
							<LocalStyleProvider colors={{ primary: "#123456" }}>
								<ThemeProbe label="local" />
							</LocalStyleProvider>
							<PluginUIFooter branch="main" sessionId={sessionId}>
								<text>Host default footer</text>
							</PluginUIFooter>
						</PluginUIHostProvider>
					</DialogProvider>
				</KeyboardLayerProvider>
			</ToastProvider>
		</ThemeProvider>,
		{ exitOnCtrlC: false, height: 16, width: 64, ...testRendererOptions }
	);
	await flushTestRenderer(setup, 2);
	if (pluginUIHost === undefined) {
		throw new Error("Plugin UI host was not mounted.");
	}
	const unbindPluginUIHost = bindPluginUIHostInEditor
		? () => undefined
		: runtime.bindPluginUIHost(sessionId, pluginUIHost);
	await runtime.startSession({ executionMode, sessionId, workspace });
	const executeCommand = async (
		pluginId: string,
		name: string,
		targetSessionId = sessionId
	): Promise<{ result: Promise<string | undefined> }> => {
		let result: Promise<string | undefined> | undefined;
		await act(async () => {
			result = runtime.executeCommand(pluginId, name, {
				argument: "",
				sessionId: targetSessionId,
				workspace,
			});
			await setup.waitForVisualIdle();
		});
		if (result === undefined) {
			throw new Error(`Plugin command ${pluginId}:${name} did not start.`);
		}
		return { result };
	};
	const pressEscape = async (): Promise<void> => {
		await act(async () => {
			setup.mockInput.pressEscape();
			await flushTestRenderer(setup, 2);
		});
	};
	const pressReclaim = async (): Promise<void> => {
		await act(async () => {
			setup.mockInput.pressKey("c", { ctrl: true });
			await flushTestRenderer(setup, 2);
		});
	};
	const customUIState = runtime.getResource<CustomUIState>(
		"plugin_ui_fixture",
		"custom_ui_state"
	);
	if (customUIState === undefined) {
		throw new Error("The custom UI fixture state was not registered.");
	}
	const executePluginTool = (name: string, id: string) => {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: runtime,
			pluginTools: runtime.getToolDescriptors(sessionId),
			sessionId,
			workspace,
		}).find(({ definition }) => definition.name.includes(name));
		if (tool === undefined) {
			throw new Error(`The ${name} fixture Tool was not registered.`);
		}
		return tool.execute({ input: {}, toolCallId: toolCallId(id) });
	};
	const executeCustomTool = () =>
		executePluginTool("ui_custom", "plugin-ui-custom-tool");
	let rendererDestroyed = false;
	const destroyRenderer = async (): Promise<void> => {
		if (rendererDestroyed) {
			return;
		}
		setup.renderer.destroy();
		await setup.renderer.closed;
		rendererDestroyed = true;
	};
	const isCustomLayerTop = (): boolean => {
		const request = pluginUIHost?.getCustomUI();
		return request === null || request === undefined
			? false
			: isTopLayer(`plugin-custom-${request.id}`);
	};
	const dispose = async (): Promise<void> => {
		if (rendererDestroyed) {
			unbindPluginUIHost();
			await runtime.shutdown();
		} else {
			await act(async () => {
				unbindPluginUIHost();
				await runtime.shutdown();
			});
			await act(() => setup.renderer.destroy());
			rendererDestroyed = true;
		}
		await fs.rm(root, { recursive: true, force: true });
	};
	return {
		dispose,
		executeCommand,
		pluginUIHost,
		runtime,
		uiUpdates,
		executeCustomTool,
		customUIState,
		destroyRenderer,
		executePluginTool,
		isCustomLayerTop,
		pressEscape,
		pressReclaim,
		unbindPluginUIHost,
		sessionId,
		setup,
		workspace,
		transcriptState,
		openAgentSession,
		configStore,
		realComposerEditor,
		realComposerState,
		setCustomEditorMounted: customEditorState.setMounted,
	};
};

test("presentation controls are view-scoped, last-setter-owned, and title updates use the approved data mapping", async () => {
	const environment = await pluginUiTestEnvironment();
	const otherSessionId = `${environment.sessionId}-other`;
	let unbindOtherSession: (() => void) | undefined;
	try {
		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		unbindOtherSession = environment.runtime.bindPluginUIHost(
			otherSessionId,
			pluginUIHost
		);
		await environment.runtime.startSession({
			executionMode: "interactive",
			sessionId: otherSessionId,
			workspace: environment.workspace,
		});
		const getPresentation = (sessionId = environment.sessionId) =>
			pluginUIHost.getContributions(sessionId);
		const { result: fixtureControls } = await environment.executeCommand(
			"plugin_ui_fixture",
			"set-presentation"
		);
		expect(await fixtureControls).toBe("true");
		await flushTestRenderer(environment.setup, 2);
		expect(getPresentation()).toMatchObject({
			hiddenThinkingLabel: "Fixture reasoning label",
			toolsExpanded: true,
			workingIndicator: { frames: ["A", "B"], intervalMs: 120 },
			workingMessage: "Fixture working message",
			workingVisible: false,
		});
		expect(environment.uiUpdates).toContainEqual({
			type: "title",
			pluginId: "plugin_ui_fixture",
			value: "Fixture terminal title",
		});

		const { result: otherViewControls } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other-presentation",
			otherSessionId
		);
		expect(await otherViewControls).toBe("false");
		await flushTestRenderer(environment.setup, 2);
		expect(getPresentation()).toMatchObject({
			hiddenThinkingLabel: "Fixture reasoning label",
			toolsExpanded: true,
			workingMessage: "Fixture working message",
			workingVisible: false,
		});
		expect(getPresentation(otherSessionId)).toMatchObject({
			hiddenThinkingLabel: "Other reasoning label",
			toolsExpanded: false,
			workingIndicator: { frames: ["O"] },
			workingMessage: "Other working message",
			workingVisible: true,
		});

		const { result: otherControls } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other-presentation"
		);
		expect(await otherControls).toBe("false");
		await flushTestRenderer(environment.setup, 2);
		expect(getPresentation()).toMatchObject({
			hiddenThinkingLabel: "Other reasoning label",
			toolsExpanded: false,
			workingIndicator: { frames: ["O"] },
			workingMessage: "Other working message",
			workingVisible: true,
		});
		expect(environment.uiUpdates).toContainEqual({
			type: "title",
			pluginId: "plugin_ui_other_fixture",
			value: "Other terminal title",
		});

		const { result: staleClear } = await environment.executeCommand(
			"plugin_ui_fixture",
			"clear-presentation"
		);
		expect(await staleClear).toBe("false");
		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_fixture",
				"Plugin disabled after losing the presentation override."
			)
		);
		await flushTestRenderer(environment.setup, 2);
		expect(getPresentation()).toMatchObject({
			hiddenThinkingLabel: "Other reasoning label",
			toolsExpanded: false,
			workingIndicator: { frames: ["O"] },
			workingMessage: "Other working message",
			workingVisible: true,
		});
		expect(getPresentation(otherSessionId)).toMatchObject({
			hiddenThinkingLabel: "Other reasoning label",
			toolsExpanded: false,
			workingIndicator: { frames: ["O"] },
			workingMessage: "Other working message",
			workingVisible: true,
		});
		expect(environment.uiUpdates).not.toContainEqual({
			type: "title",
			pluginId: "plugin_ui_fixture",
			value: null,
		});

		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_other_fixture",
				"Plugin disabled to restore presentation defaults."
			)
		);
		await flushTestRenderer(environment.setup, 2);
		expect(getPresentation()).toMatchObject({
			statuses: [],
			widgets: [],
		});
		const defaults = getPresentation();
		expect(defaults.hiddenThinkingLabel).toBeUndefined();
		expect(defaults.workingIndicator).toBeUndefined();
		expect(defaults.workingMessage).toBeUndefined();
		expect(defaults.workingVisible).toBeUndefined();
		expect(defaults.toolsExpanded ?? false).toBe(false);
		expect(getPresentation(otherSessionId)).toMatchObject({
			statuses: [],
			widgets: [],
		});
		expect(environment.uiUpdates).toContainEqual({
			type: "title",
			pluginId: "plugin_ui_other_fixture",
			value: null,
		});
	} finally {
		unbindOtherSession?.();
		await environment.dispose();
	}
});

test("stopping a Plugin Session clears its view contributions and closes old UI handles", async () => {
	const environment = await pluginUiTestEnvironment();
	let unbindOtherSession: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		const sessionContext = {
			executionMode: "interactive" as const,
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		};
		const otherSessionId = `${environment.sessionId}-other`;
		const otherSessionContext = {
			...sessionContext,
			sessionId: otherSessionId,
		};
		unbindOtherSession = environment.runtime.bindPluginUIHost(
			otherSessionId,
			pluginUIHost
		);
		await environment.runtime.startSession(otherSessionContext);
		const otherUI = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			otherSessionId
		);
		await act(() => otherUI.setStatus("lifecycle", "Other Session value"));
		let notifications = 0;
		unsubscribe = pluginUIHost.subscribeContributions(
			environment.sessionId,
			() => notifications++
		);
		const oldUI = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		await act(() => {
			oldUI.setStatus("lifecycle", "Old Session value");
			oldUI.setHiddenThinkingLabel("Old Session label");
			oldUI.setToolsExpanded(true);
		});
		const notificationsBeforeStop = notifications;
		await act(async () => environment.runtime.stopSession(sessionContext));
		await flushTestRenderer(environment.setup, 2);

		expect(pluginUIHost.getContributions(environment.sessionId)).toEqual({
			statuses: [],
			widgets: [],
		});
		expect(pluginUIHost.getContributions(otherSessionId).statuses).toEqual([
			{
				key: "lifecycle",
				pluginId: "plugin_ui_fixture",
				value: "Other Session value",
			},
		]);
		expect(notifications).toBe(notificationsBeforeStop + 1);
		const notificationsAfterStop = notifications;
		await act(() => oldUI.setStatus("stale", "Must not be published"));
		expect(pluginUIHost.getContributions(environment.sessionId)).toEqual({
			statuses: [],
			widgets: [],
		});
		expect(notifications).toBe(notificationsAfterStop);

		await act(async () => environment.runtime.startSession(sessionContext));
		const newUI = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		expect(newUI).not.toBe(oldUI);
		await act(() => newUI.setStatus("lifecycle", "New Session value"));
		expect(
			pluginUIHost.getContributions(environment.sessionId).statuses
		).toEqual([
			{
				key: "lifecycle",
				pluginId: "plugin_ui_fixture",
				value: "New Session value",
			},
		]);
		expect(notifications).toBe(notificationsAfterStop + 1);
	} finally {
		unsubscribe?.();
		unbindOtherSession?.();
		await environment.dispose();
	}
});

test("a fresh Plugin runtime after shutdown starts with empty UI state and accepts new registrations", async () => {
	const environment = await pluginUiTestEnvironment();
	let reloadedRuntime: PluginRuntime | undefined;
	let unbindReloadedHost: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		const sessionContext = {
			executionMode: "interactive" as const,
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		};
		let notifications = 0;
		unsubscribe = pluginUIHost.subscribeContributions(
			environment.sessionId,
			() => notifications++
		);
		const oldUI = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		await act(() => {
			oldUI.setStatus("old", "Old runtime state");
			oldUI.setHiddenThinkingLabel("Old runtime label");
		});
		await act(async () => environment.runtime.shutdown());
		await flushTestRenderer(environment.setup, 2);
		const notificationsAfterShutdown = notifications;
		expect(pluginUIHost.getContributions(environment.sessionId)).toEqual({
			statuses: [],
			widgets: [],
		});
		expect(notificationsAfterShutdown).toBeGreaterThan(0);
		await act(() => oldUI.setStatus("stale", "Must not survive shutdown"));
		expect(pluginUIHost.getContributions(environment.sessionId)).toEqual({
			statuses: [],
			widgets: [],
		});
		expect(notifications).toBe(notificationsAfterShutdown);

		const root = path.dirname(environment.workspace);
		const nextRuntime = await loadPlugins({
			bundledPlugins: [{ factory: pluginUiFixture, id: "plugin_ui_fixture" }],
			cliPaths: [],
			config: {
				configStore: environment.configStore,
				cwd: environment.workspace,
				homeRoot: root,
				trustedProjectRoots: [environment.workspace],
				workspace: environment.workspace,
			},
			userDataDir: root,
		});
		reloadedRuntime = nextRuntime;
		unbindReloadedHost = nextRuntime.bindPluginUIHost(
			environment.sessionId,
			pluginUIHost
		);
		await nextRuntime.startSession(sessionContext);
		expect(pluginUIHost.getContributions(environment.sessionId)).toEqual({
			statuses: [],
			widgets: [],
		});

		let registrationResult: Promise<string | undefined> | undefined;
		await act(async () => {
			registrationResult = nextRuntime.executeCommand(
				"plugin_ui_fixture",
				"set-presentation",
				{
					argument: "",
					sessionId: environment.sessionId,
					workspace: environment.workspace,
				}
			);
			await environment.setup.waitForVisualIdle();
		});
		if (registrationResult === undefined) {
			throw new Error("The reloaded Plugin Command did not start.");
		}
		expect(await registrationResult).toBe("true");
		expect(pluginUIHost.getContributions(environment.sessionId)).toMatchObject({
			hiddenThinkingLabel: "Fixture reasoning label",
			toolsExpanded: true,
		});
		const notificationsAfterRegistration = notifications;
		await act(() => oldUI.setStatus("late", "Old runtime must stay closed"));
		expect(
			pluginUIHost
				.getContributions(environment.sessionId)
				.statuses.some(({ key }) => key === "late")
		).toBe(false);
		expect(notifications).toBe(notificationsAfterRegistration);
	} finally {
		unsubscribe?.();
		const runtimeToShutdown = reloadedRuntime;
		if (runtimeToShutdown !== undefined) {
			await act(async () => runtimeToShutdown.shutdown());
		}
		unbindReloadedHost?.();
		await environment.dispose();
	}
});

test("Plugin editor ownership rejects competitors and restores the default on unload", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const owner = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		const competitor = environment.runtime.getPluginUI(
			"plugin_ui_other_fixture",
			environment.sessionId
		);
		let registered: PluginUIContributionResult | undefined;
		await act(async () => {
			registered = owner.setEditorComponent(WrappedPluginEditor);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(registered).toEqual({ success: true });
		expect(owner.getEditorComponent()).toBe(WrappedPluginEditor);
		expect(competitor.getEditorComponent()).toBeUndefined();
		expect(environment.setup.captureCharFrame()).toContain(
			"Wrapped host editor"
		);
		await act(async () => {
			registered = owner.setEditorComponent(ReplacementPluginEditor);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(registered).toEqual({ success: true });
		expect(owner.getEditorComponent()).toBe(ReplacementPluginEditor);
		expect(environment.setup.captureCharFrame()).toContain(
			"Replacement host editor"
		);

		let conflict: PluginUIContributionResult | undefined;
		await act(async () => {
			conflict = competitor.setEditorComponent(WrappedPluginEditor);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(conflict).toEqual({
			code: "plugin_ui_contribution_conflict",
			ownerPluginId: "plugin_ui_fixture",
			success: false,
			surface: "editor",
		});
		expect(environment.setup.captureCharFrame()).toContain(
			"Replacement host editor"
		);

		await act(async () => {
			registered = owner.setEditorComponent(undefined);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(registered).toEqual({ success: true });
		expect(owner.getEditorComponent()).toBeUndefined();
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Replacement host editor"
		);
		await act(async () => {
			registered = owner.setEditorComponent(WrappedPluginEditor);
			await flushTestRenderer(environment.setup, 2);
		});

		await act(async () => {
			environment.runtime.disablePlugin("plugin_ui_fixture", "fixture unload");
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Wrapped host editor"
		);
		expect(owner.getEditorText()).toBeUndefined();
		expect(owner.setEditorText("stale")).toBe(false);
		expect(owner.pasteToEditor("stale")).toBe(false);
		expect(owner.setEditorComponent(WrappedPluginEditor)).toBeUndefined();
		await act(async () => {
			registered = competitor.setEditorComponent(WrappedPluginEditor);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(registered).toEqual({ success: true });
	} finally {
		await environment.dispose();
	}
});

test("Plugin editor ownership is scoped per Session while conflicts remain local", async () => {
	const environment = await pluginUiTestEnvironment();
	let unbindOtherSession: (() => void) | undefined;
	try {
		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		const otherSessionId = `${environment.sessionId}-other`;
		unbindOtherSession = environment.runtime.bindPluginUIHost(
			otherSessionId,
			pluginUIHost
		);
		await environment.runtime.startSession({
			executionMode: "interactive",
			sessionId: otherSessionId,
			workspace: environment.workspace,
		});

		const owner = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		const sameSessionCompetitor = environment.runtime.getPluginUI(
			"plugin_ui_other_fixture",
			environment.sessionId
		);
		const otherSessionOwner = environment.runtime.getPluginUI(
			"plugin_ui_other_fixture",
			otherSessionId
		);
		let ownerRegistration: PluginUIContributionResult | undefined;
		let conflict: PluginUIContributionResult | undefined;
		let otherSessionRegistration: PluginUIContributionResult | undefined;
		await act(async () => {
			ownerRegistration = owner.setEditorComponent(WrappedPluginEditor);
			conflict = sameSessionCompetitor.setEditorComponent(
				ReplacementPluginEditor
			);
			otherSessionRegistration = otherSessionOwner.setEditorComponent(
				ReplacementPluginEditor
			);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(ownerRegistration).toEqual({ success: true });
		expect(conflict).toEqual({
			code: "plugin_ui_contribution_conflict",
			ownerPluginId: "plugin_ui_fixture",
			success: false,
			surface: "editor",
		});
		expect(otherSessionRegistration).toEqual({ success: true });

		expect(owner.getEditorComponent()).toBe(WrappedPluginEditor);
		expect(sameSessionCompetitor.getEditorComponent()).toBeUndefined();
		expect(otherSessionOwner.getEditorComponent()).toBe(
			ReplacementPluginEditor
		);
		await act(async () => {
			owner.setEditorComponent(undefined);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(owner.getEditorComponent()).toBeUndefined();
		expect(otherSessionOwner.getEditorComponent()).toBe(
			ReplacementPluginEditor
		);
	} finally {
		unbindOtherSession?.();
		await environment.dispose();
	}
});

test("header and footer have host-wide first-owner conflicts and restore defaults without stacking", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		false,
		[],
		undefined,
		true
	);
	const otherSessionId = `${environment.sessionId}-other`;
	let unbindOtherSession: (() => void) | undefined;
	try {
		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		unbindOtherSession = environment.runtime.bindPluginUIHost(
			otherSessionId,
			pluginUIHost
		);
		await environment.runtime.startSession({
			executionMode: "interactive",
			sessionId: otherSessionId,
			workspace: environment.workspace,
		});
		const { result: ownerResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"set-ui-chrome"
		);
		expect(JSON.parse((await ownerResult) ?? "{}")).toEqual({
			header: { success: true },
			footer: { success: true },
		});
		await flushTestRenderer(environment.setup, 2);
		let frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Fixture header opencode 64x16");
		expect(frame).toContain("Fixture footer opencode 64x16 main");

		const { result: competingResult } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"compete-ui-chrome",
			otherSessionId
		);
		expect(JSON.parse((await competingResult) ?? "{}")).toEqual({
			header: {
				code: "plugin_ui_contribution_conflict",
				success: false,
				surface: "header",
			},
			footer: {
				code: "plugin_ui_contribution_conflict",
				success: false,
				surface: "footer",
			},
		});
		const { result: competingClear } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other-clear-ui-chrome",
			otherSessionId
		);
		expect(JSON.parse((await competingClear) ?? "{}")).toMatchObject({
			header: { success: false, surface: "header" },
			footer: { success: false, surface: "footer" },
		});
		await flushTestRenderer(environment.setup, 2);
		frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Fixture header opencode 64x16");
		expect(frame).toContain("Fixture footer opencode 64x16 main");
		expect(frame).not.toContain("Other Plugin header");

		const { result: replacementResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"replace-ui-header"
		);
		expect(JSON.parse((await replacementResult) ?? "{}")).toEqual({
			success: true,
		});
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Replacement header opencode"
		);

		const { result: ownerClear } = await environment.executeCommand(
			"plugin_ui_fixture",
			"clear-ui-chrome"
		);
		expect(JSON.parse((await ownerClear) ?? "{}")).toEqual({
			header: { success: true },
			footer: { success: true },
		});
		await flushTestRenderer(environment.setup, 2);
		frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Host default header");
		expect(frame).toContain("Host default footer");
		expect(frame).not.toContain("Other Plugin header");

		const { result: explicitClaim } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"claim-ui-chrome"
		);
		expect(JSON.parse((await explicitClaim) ?? "{}")).toEqual({
			header: { success: true },
			footer: { success: true },
		});
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Other Plugin header"
		);

		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_other_fixture",
				"Plugin disabled for chrome ownership test."
			)
		);
		await flushTestRenderer(environment.setup, 2);
		frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Host default header");
		expect(frame).toContain("Host default footer");
	} finally {
		unbindOtherSession?.();
		await environment.dispose();
	}
});

test("status and widget keys sort by Plugin Identifier and key, coexist across owners, and clear independently", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: fixtureSet } = await environment.executeCommand(
			"plugin_ui_fixture",
			"ui-contributions"
		);
		const { result: otherSet } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other-ui-contributions"
		);
		expect(await fixtureSet).toBe("contributions set");
		expect(await otherSet).toBe("other contributions set");
		await flushTestRenderer(environment.setup, 2);

		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Other Plugin alpha status");
		expect(frame).toContain("Fixture alpha widget");
		expect(frame).toContain("Fixture shared widget");
		expect(frame).toContain("Other Plugin alpha widget");
		expect(frame).toContain("Other Plugin shared widget");
		expect(frame).toContain("Fixture below widget");
		expect(frame.indexOf("Fixture alpha widget")).toBeLessThan(
			frame.indexOf("Fixture shared widget")
		);
		expect(frame.indexOf("Fixture alpha widget")).toBeLessThan(
			frame.indexOf("Other Plugin alpha widget")
		);
		expect(frame.indexOf("Fixture alpha widget")).toBeLessThan(
			frame.indexOf("Fixture composer")
		);
		expect(frame.indexOf("Fixture below widget")).toBeGreaterThan(
			frame.indexOf("Fixture composer")
		);
		const snapshot = environment.pluginUIHost?.getContributions(
			environment.sessionId
		);
		if (snapshot === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		expect(
			snapshot.statuses.map(({ pluginId, key }) => `${pluginId}/${key}`)
		).toEqual([
			"plugin_ui_fixture/alpha",
			"plugin_ui_fixture/shared",
			"plugin_ui_other_fixture/alpha",
			"plugin_ui_other_fixture/shared",
		]);
		expect(
			snapshot.widgets.map(({ pluginId, key }) => `${pluginId}/${key}`)
		).toEqual([
			"plugin_ui_fixture/alpha",
			"plugin_ui_fixture/below",
			"plugin_ui_fixture/shared",
			"plugin_ui_other_fixture/alpha",
			"plugin_ui_other_fixture/shared",
		]);
		expect(environment.uiUpdates).toContainEqual({
			type: "status",
			pluginId: "plugin_ui_fixture",
			key: "shared",
			value: "Fixture shared status",
		});
		expect(environment.uiUpdates).toContainEqual({
			type: "widget",
			pluginId: "plugin_ui_fixture",
			key: "shared",
			value: ["Fixture shared widget"],
			placement: "aboveEditor",
		});

		const { result: fixtureClear } = await environment.executeCommand(
			"plugin_ui_fixture",
			"clear-ui-contributions"
		);
		expect(await fixtureClear).toBe("contributions cleared");
		expect(environment.uiUpdates).toContainEqual({
			type: "status",
			pluginId: "plugin_ui_fixture",
			key: "shared",
			value: null,
		});
		expect(environment.uiUpdates).toContainEqual({
			type: "widget",
			pluginId: "plugin_ui_fixture",
			key: "shared",
			value: null,
			placement: "aboveEditor",
		});
		await flushTestRenderer(environment.setup, 2);
		const afterFixtureClear = environment.setup.captureCharFrame();
		const afterFixtureClearSnapshot =
			environment.pluginUIHost?.getContributions(environment.sessionId);
		if (afterFixtureClearSnapshot === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		expect(
			afterFixtureClearSnapshot.statuses.map(
				({ pluginId, key }) => `${pluginId}/${key}`
			)
		).toEqual([
			"plugin_ui_other_fixture/alpha",
			"plugin_ui_other_fixture/shared",
		]);
		expect(
			afterFixtureClearSnapshot.widgets.map(
				({ pluginId, key }) => `${pluginId}/${key}`
			)
		).toEqual([
			"plugin_ui_other_fixture/alpha",
			"plugin_ui_other_fixture/shared",
		]);
		expect(afterFixtureClear).not.toContain("Fixture shared widget");
		expect(afterFixtureClear).not.toContain("Fixture alpha widget");
		expect(afterFixtureClear).toContain("Other Plugin shared widget");
		expect(afterFixtureClear).toContain("Other Plugin alpha widget");

		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_other_fixture",
				"Plugin disabled for contribution ownership test."
			)
		);
		await flushTestRenderer(environment.setup, 2);
		expect(
			environment.pluginUIHost?.getContributions(environment.sessionId).statuses
		).toEqual([]);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Other Plugin shared widget"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Other Plugin alpha widget"
		);
	} finally {
		await environment.dispose();
	}
});

test("the verified contribution example renders and clears its Plugin UI surfaces", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		false,
		[],
		undefined,
		true
	);
	try {
		const { result: setResult } = await environment.executeCommand(
			"issue_tracker_ui",
			"show-issue-ui"
		);
		expect(await setResult).toBe("Issue-tracker UI contributions enabled.");
		await flushTestRenderer(environment.setup, 2);

		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		const contributions = pluginUIHost.getContributions(environment.sessionId);
		expect(contributions.statuses).toEqual([
			{
				key: "sync",
				pluginId: "issue_tracker_ui",
				value: "Issue tracker connected",
			},
		]);
		expect(contributions.widgets).toEqual([
			{
				key: "issue",
				lines: ["Open issues: 4", "Reviews waiting: 2"],
				placement: "aboveEditor",
				pluginId: "issue_tracker_ui",
			},
			{
				key: "sync-detail",
				lines: ["Last checked just now"],
				placement: "belowEditor",
				pluginId: "issue_tracker_ui",
			},
		]);
		expect(contributions).toMatchObject({
			hiddenThinkingLabel: "Issue-tracker reasoning",
			toolsExpanded: true,
			workingIndicator: {
				frames: ["·", "•", "●", "•"],
				intervalMs: 120,
			},
			workingMessage: "Checking issue status...",
		});
		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Issue tracker · 64 columns");
		expect(frame).toContain("Issue tracker connected");
		expect(frame).toContain("Open issues: 4");
		expect(frame).toContain("Last checked just now");
		expect(environment.uiUpdates).toContainEqual({
			type: "title",
			pluginId: "issue_tracker_ui",
			value: "Wincode · Issue tracker",
		});

		const { result: clearResult } = await environment.executeCommand(
			"issue_tracker_ui",
			"clear-issue-ui"
		);
		expect(await clearResult).toBe("Issue-tracker UI contributions cleared.");
		await flushTestRenderer(environment.setup, 2);
		expect(pluginUIHost.getChrome()).toEqual({ header: null, footer: null });
		expect(pluginUIHost.getTitle()).toBeNull();
		expect(
			pluginUIHost.getContributions(environment.sessionId).statuses
		).toEqual([]);
		expect(
			pluginUIHost.getContributions(environment.sessionId).widgets
		).toEqual([]);
		const restoredFrame = environment.setup.captureCharFrame();
		expect(restoredFrame).toContain("Host default header");
		expect(restoredFrame).toContain("Host default footer");
		expect(restoredFrame).not.toContain("Issue tracker · 64 columns");
	} finally {
		await environment.dispose();
	}
});

test("disabling a Plugin after its view unbinds clears host-wide chrome and title", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		true,
		[],
		undefined,
		true
	);
	try {
		const { result } = await environment.executeCommand(
			"issue_tracker_ui",
			"show-issue-ui"
		);
		expect(await result).toBe("Issue-tracker UI contributions enabled.");
		await flushTestRenderer(environment.setup, 2);

		const pluginUIHost = environment.pluginUIHost;
		if (pluginUIHost === undefined) {
			throw new Error("The Plugin UI host fixture was not bound.");
		}
		await act(() => environment.setCustomEditorMounted(false));
		await flushTestRenderer(environment.setup, 2);
		expect(pluginUIHost.getChrome().header?.pluginId).toBe("issue_tracker_ui");
		expect(pluginUIHost.getTitle()).toEqual({
			pluginId: "issue_tracker_ui",
			value: "Wincode · Issue tracker",
		});
		expect(environment.setup.captureCharFrame()).toContain(
			"Issue tracker · 64 columns"
		);

		await act(() =>
			environment.runtime.disablePlugin(
				"issue_tracker_ui",
				"Plugin disabled after its Session view unbound."
			)
		);
		await flushTestRenderer(environment.setup, 2);
		expect(pluginUIHost.getChrome()).toEqual({ header: null, footer: null });
		expect(pluginUIHost.getTitle()).toBeNull();
		expect(environment.setup.captureCharFrame()).toContain(
			"Host default header"
		);
		expect(environment.uiUpdates).toContainEqual({
			type: "title",
			pluginId: "issue_tracker_ui",
			value: null,
		});
	} finally {
		await environment.dispose();
	}
});

test("view presentation contributions render their hidden-thinking label and expand shell output", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		height: 30,
		width: 88,
	});
	try {
		await act(async () => {
			environment.transcriptState.showContributionMessage();
			await flushTestRenderer(environment.setup, 3);
			await environment.configStore.getSnapshot(environment.workspace);
			await flushTestRenderer(environment.setup);
		});
		await act(async () => environment.transcriptState.setHideThinking());
		await flushTestRenderer(environment.setup, 3);
		let frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Thinking...");
		expect(frame).not.toContain("private reasoning text");
		expect(frame).toContain("(Ctrl+O: Expand)");
		expect(frame).not.toContain("final expanded output line");

		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"set-presentation"
		);
		expect(await result).toBe("true");
		await flushTestRenderer(environment.setup, 3);
		frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Fixture reasoning label");
		expect(frame).not.toContain("Thinking...");
		expect(frame).not.toContain("private reasoning text");
		expect(frame).toContain("final expanded output line");
		expect(frame).toContain("(Ctrl+O: Collapse)");
		expect(frame).not.toContain("(Ctrl+O: Expand)");
	} finally {
		await environment.dispose();
	}
});

test("Plugin autocomplete providers unregister and release with their owner", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const first: PluginAutocompleteProviderFactory = (current) => current;
		const second: PluginAutocompleteProviderFactory = (current) => current;
		const firstUI = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		const secondUI = environment.runtime.getPluginUI(
			"plugin_ui_other_fixture",
			environment.sessionId
		);
		let removeFirst: (() => void) | undefined;
		let removeSecond: (() => void) | undefined;
		await act(async () => {
			removeFirst = firstUI.addAutocompleteProvider(first);
			removeSecond = secondUI.addAutocompleteProvider(second);
			await flushTestRenderer(environment.setup, 2);
		});

		expect(
			environment.pluginUIHost.getAutocompleteProviders(environment.sessionId)
		).toEqual([first, second]);
		await act(async () => {
			removeFirst?.();
			await flushTestRenderer(environment.setup, 2);
		});
		expect(
			environment.pluginUIHost.getAutocompleteProviders(environment.sessionId)
		).toEqual([second]);

		await act(async () => {
			firstUI.addAutocompleteProvider(first);
			await flushTestRenderer(environment.setup, 2);
		});
		await act(async () => {
			await environment.runtime.disablePlugin(
				"plugin_ui_fixture",
				"fixture unload"
			);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(
			environment.pluginUIHost.getAutocompleteProviders(environment.sessionId)
		).toEqual([second]);
		await act(async () => {
			removeSecond?.();
			await flushTestRenderer(environment.setup, 2);
		});
		expect(
			environment.pluginUIHost.getAutocompleteProviders(environment.sessionId)
		).toEqual([]);
	} finally {
		await environment.dispose();
	}
});

test("Plugin UI reads, sets, and pastes text through the mounted Session composer", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const ui = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		expect(ui.getEditorText()).toBe("");
		await act(async () => {
			expect(ui.setEditorText("Draft from Plugin")).toBe(true);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(ui.getEditorText()).toBe("Draft from Plugin");
		await act(async () => {
			expect(ui.pasteToEditor(" pasted text")).toBe(true);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(ui.getEditorText()).toBe("Draft from Plugin pasted text");
	} finally {
		await environment.dispose();
	}
});

test("a direct Plugin Command opens custom UI, returns once, and restores its composer", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const initialFactoryCalls = environment.customUIState.factoryCalls;
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);

		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.setup.captureCharFrame()).toContain("Custom response");
		expect(environment.setup.captureCharFrame()).toContain("Escape dismiss");
		expect(environment.setup.captureCharFrame()).toContain(
			"Ctrl+C reclaim editor"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Plugin UI invitation"
		);
		expect(environment.setup.captureCharFrame()).toContain(
			"opencode:64x16:6:interactive"
		);
		expect(environment.customUIState.factoryCalls).toBe(
			initialFactoryCalls + 1
		);
		expect(environment.customUIState.lastContext?.presentation).toBe("editor");
		const editorBounds =
			environment.customUIState.lastContext?.presentationHandle.getBounds();
		if (editorBounds === undefined) {
			throw new Error(
				"The custom editor did not receive its presentation handle."
			);
		}
		expect(editorBounds.width).toBeGreaterThan(0);
		expect(editorBounds.height).toBeGreaterThan(0);

		await act(() => environment.setup.mockInput.typeText("local response"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("local response");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);
	} finally {
		await environment.dispose();
	}
});

test("Plugin shortcuts remain available when host binding precedes partial Session registration failure", async () => {
	const pluginId = "plugin_partial_registration";
	const shortcutState = { calls: 0 };
	const partialRegistrationPlugin: PluginFactory = (api) => {
		const plugin = api.definePlugin({ id: pluginId });
		api.registerShortcut("ctrl+shift+p", {
			description: "Remain available after partial Session registration.",
			handler: () => {
				shortcutState.calls += 1;
			},
		});
		plugin.onSessionStart((_context, registrationApi) => {
			registrationApi.registerCommand({
				description: "Confirm the partial Session scope was published.",
				handler: () => "Partial Session scope published",
				name: "partial-scope",
			});
			registrationApi.registerCommand({
				description: "Trigger a nonfatal registration error.",
				handler: () => "unreachable",
				name: "",
			});
		});
	};
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{ kittyKeyboard: true },
		true,
		[{ factory: partialRegistrationPlugin, id: pluginId }]
	);
	try {
		const { result } = await environment.executeCommand(
			pluginId,
			"partial-scope"
		);
		expect(await result).toBe("Partial Session scope published");

		await act(async () => {
			environment.setup.mockInput.pressKey("p", { ctrl: true, shift: true });
			await flushTestRenderer(environment.setup, 2);
		});
		expect(shortcutState.calls).toBe(1);
	} finally {
		await environment.dispose();
	}
});

test("an overlay keeps the live application visible and returns its component result", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		height: 16,
		width: 64,
	});
	try {
		await act(() => environment.setup.mockInput.typeText("overlay draft"));
		await flushTestRenderer(environment.setup, 2);
		const renderer = environment.setup.renderer;
		const rendererRoot = renderer.root;
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-overlay"
		);
		await flushTestRenderer(environment.setup, 2);

		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("Fixture custom UI");
		expect(frame).toContain("Ctrl+C reclaim app");
		expect(frame).toContain("Fixture composer");
		expect(frame).toContain("Plugin UI host fixture · update 0");
		expect(environment.setup.renderer).toBe(renderer);
		expect(environment.setup.renderer.root).toBe(rendererRoot);
		expect(environment.customUIState.lastContext?.presentation).toBe("overlay");
		expect(environment.customUIState.lastFactoryBounds).toEqual({
			left: 2,
			top: 2,
			width: 60,
			height: 12,
		});
		expect(
			environment.customUIState.lastContext?.presentationHandle.getBounds()
		).toEqual({ left: 2, top: 2, width: 60, height: 12 });
		const dimensions = environment.customUIState.lastComponentDimensions;
		if (dimensions === undefined) {
			throw new Error("The custom overlay did not render its component.");
		}
		expect(dimensions.width).toBeGreaterThan(0);
		expect(dimensions.width).toBeLessThanOrEqual(64);
		expect(dimensions.height).toBeGreaterThan(0);
		expect(dimensions.height).toBeLessThanOrEqual(16);

		await act(() => environment.setup.mockInput.typeText("overlay response"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);
		expect(await result).toBe("overlay response");
		await act(() => environment.setup.mockInput.typeText(" restored"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"overlay draft restored"
		);
	} finally {
		await environment.dispose();
	}
});

test("Plugin shortcuts and raw input preserve focused UI and host key precedence", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		kittyKeyboard: true,
	});
	const keyboardState = environment.runtime.getResource<PluginKeyboardState>(
		"plugin_ui_fixture",
		"keyboard_state"
	);
	const otherKeyboardState =
		environment.runtime.getResource<OtherPluginKeyboardState>(
			"plugin_ui_other_fixture",
			"keyboard_state"
		);
	if (keyboardState === undefined || otherKeyboardState === undefined) {
		throw new Error(
			`The keyboard fixture Plugin state was not registered: ${environment.runtime
				.getLoadedPlugins()
				.map(({ id }) => id)
				.join(
					","
				)}; ${environment.runtime.diagnostics.map(({ message }) => message).join(" | ")}`
		);
	}
	const pressShortcut = async (): Promise<void> => {
		await act(async () => {
			environment.setup.mockInput.pressKey("p", { ctrl: true, shift: true });
			await flushTestRenderer(environment.setup, 2);
		});
	};
	const pressX = async (): Promise<void> => {
		await act(async () => {
			environment.setup.mockInput.pressKey("x");
			await flushTestRenderer(environment.setup, 2);
		});
	};
	try {
		await pressShortcut();
		expect(keyboardState.shortcutCalls).toBe(1);
		expect(otherKeyboardState.shortcutCalls).toBe(1);
		expect(keyboardState.shortcutContexts).toEqual([
			`plugin_ui_fixture:${environment.sessionId}:ctrl+shift+p`,
		]);
		expect(keyboardState.shortcutThemeCount).toBeGreaterThan(0);

		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"keyboard"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Keyboard fixture");

		await pressShortcut();
		expect(keyboardState.shortcutCalls).toBe(1);
		expect(keyboardState.localInputs).toEqual(["Ctrl+Shift+P"]);
		expect(environment.setup.captureCharFrame()).toContain("Keyboard fixture");

		await pressX();
		expect(keyboardState.inputEvents).toContain("\u001b[120u");
		expect(keyboardState.localInputs).toEqual(["Ctrl+Shift+P"]);

		await environment.pressEscape();
		expect(await result).toBe("undefined");
		expect(keyboardState.inputEvents).not.toContain("\u001b");
		const inputCount = keyboardState.inputEvents.length;
		await pressX();
		expect(keyboardState.inputEvents).toHaveLength(inputCount);
	} finally {
		await environment.dispose();
	}
});

test("PluginAPI rejects shortcut registrations for host-owned keys", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-shortcut-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const shortcuts = [
		{ id: "plugin_escape_shortcut", shortcut: "escape" },
		{ id: "plugin_ctrl_c_shortcut", shortcut: "ctrl+c" },
	] as const;
	const runtime = await loadPlugins({
		bundledPlugins: shortcuts.map(
			({ id, shortcut }): Readonly<{ factory: PluginFactory; id: string }> => ({
				factory: (api) => {
					api.definePlugin({ id });
					api.registerShortcut(shortcut, {
						description: "Attempt to replace a host-owned key.",
						handler: () => undefined,
					});
				},
				id,
			})
		),
		cliPaths: [],
		config: {
			configStore: createConfigStore({
				homeRoot: root,
				trustedProjectRoots: [workspace],
			}),
			cwd: workspace,
			homeRoot: root,
			trustedProjectRoots: [workspace],
			workspace,
		},
		userDataDir: root,
	});
	try {
		const shortcutFailures = runtime.diagnostics.filter(({ message }) =>
			message.includes("Plugin factory failed")
		);
		expect(shortcutFailures).toHaveLength(2);
		expect(shortcutFailures.map(({ message }) => message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("reserved Escape or Ctrl+C"),
				expect.stringContaining("reserved Escape or Ctrl+C"),
			])
		);
		for (const { id } of shortcuts) {
			expect(
				runtime.getLoadedPlugins().map(({ id: loadedId }) => loadedId)
			).not.toContain(id);
		}
	} finally {
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("PluginAPI rejects modifier-free shortcuts without consuming ordinary input", async () => {
	const pluginId = "plugin_plain_shortcut";
	const shortcutCalls = { count: 0 };
	const plainShortcutPlugin: PluginFactory = (api) => {
		api.definePlugin({ id: pluginId });
		api.registerShortcut("p", {
			description: "Attempt to claim ordinary character input.",
			handler: () => {
				shortcutCalls.count += 1;
			},
		});
	};
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{ kittyKeyboard: true },
		false,
		[{ factory: plainShortcutPlugin, id: pluginId }]
	);
	try {
		expect(
			environment.runtime.getLoadedPlugins().map(({ id }) => id)
		).not.toContain(pluginId);
		expect(
			environment.runtime.diagnostics.some(({ message }) =>
				message.includes("modifier+key notation")
			)
		).toBe(true);

		await act(async () => {
			environment.setup.mockInput.pressKey("p");
			await flushTestRenderer(environment.setup, 2);
		});
		expect(shortcutCalls.count).toBe(0);
		expect(
			environment.setup
				.captureCharFrame()
				.split("\n")
				.map((line) => line.trim())
		).toContain("p");
	} finally {
		await environment.dispose();
	}
});

test("a matching Plugin Meta+W shortcut runs when the host does not claim it", async () => {
	const pluginId = "plugin_meta_w_shortcut_control";
	const pluginShortcutCalls = { count: 0 };
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: pluginId });
		api.registerShortcut("meta+w", {
			description: "A modified shortcut control.",
			handler: () => {
				pluginShortcutCalls.count += 1;
			},
		});
	};
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{ kittyKeyboard: false },
		false,
		[{ factory: plugin, id: pluginId }]
	);
	try {
		await act(async () => {
			environment.setup.mockInput.pressKey("w", { meta: true });
			await flushTestRenderer(environment.setup, 2);
		});
		expect(pluginShortcutCalls.count).toBe(1);
	} finally {
		await environment.dispose();
	}
});

test("a host Meta+W action suppresses a matching Plugin shortcut", async () => {
	const pluginId = "plugin_meta_w_shortcut";
	const pluginShortcutCalls = { count: 0 };
	const plugin: PluginFactory = (api) => {
		api.definePlugin({ id: pluginId });
		api.registerShortcut("meta+w", {
			description: "Conflicts with the host Meta+W action.",
			handler: () => {
				pluginShortcutCalls.count += 1;
			},
		});
	};
	let hostActionCalls = 0;
	const hostKeyFlags: { meta: boolean; option: boolean }[] = [];
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{ kittyKeyboard: false },
		false,
		[{ factory: plugin, id: pluginId }],
		(key) => {
			hostActionCalls += 1;
			hostKeyFlags.push(key);
		}
	);
	try {
		expect(
			environment.runtime.getLoadedPlugins().map(({ id }) => id)
		).toContain(pluginId);
		await act(async () => {
			environment.setup.mockInput.pressKey("w", { meta: true });
			await flushTestRenderer(environment.setup, 2);
		});

		expect(hostActionCalls).toBe(1);
		expect(hostKeyFlags).toEqual([{ meta: true, option: false }]);
		expect(pluginShortcutCalls.count).toBe(0);
	} finally {
		await environment.dispose();
	}
});

test("raw Plugin input cannot consume reserved dismissal or reclaim keys", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		kittyKeyboard: true,
	});
	const keyboardState = environment.runtime.getResource<PluginKeyboardState>(
		"plugin_ui_fixture",
		"keyboard_state"
	);
	if (keyboardState === undefined) {
		throw new Error("The keyboard fixture Plugin state was not registered.");
	}
	try {
		const { result: escapeResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"keyboard-consume"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressEscape();
		expect(await escapeResult).toBe("undefined");
		expect(keyboardState.consumingInputs).toHaveLength(0);

		const { result: reclaimResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"keyboard-consume"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressReclaim();
		expect(await reclaimResult).toBe("undefined");
		expect(keyboardState.consumingInputs).toHaveLength(0);
	} finally {
		await environment.dispose();
	}
});

test("Plugin view cleanup removes only that owner's shortcuts and raw listeners", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		kittyKeyboard: true,
	});
	const keyboardState = environment.runtime.getResource<PluginKeyboardState>(
		"plugin_ui_fixture",
		"keyboard_state"
	);
	const otherKeyboardState =
		environment.runtime.getResource<OtherPluginKeyboardState>(
			"plugin_ui_other_fixture",
			"keyboard_state"
		);
	if (keyboardState === undefined || otherKeyboardState === undefined) {
		throw new Error("The keyboard fixture Plugin state was not registered.");
	}
	const pressShortcut = async (): Promise<void> => {
		await act(async () => {
			environment.setup.mockInput.pressKey("p", { ctrl: true, shift: true });
			await flushTestRenderer(environment.setup, 2);
		});
	};
	const pressX = async (): Promise<void> => {
		await act(async () => {
			environment.setup.mockInput.pressKey("x");
			await flushTestRenderer(environment.setup, 2);
		});
	};
	try {
		await environment.executeCommand(
			"plugin_ui_fixture",
			"listen-terminal-input"
		);
		await environment.executeCommand(
			"plugin_ui_other_fixture",
			"listen-other-terminal-input"
		);
		await pressX();
		expect(keyboardState.inputEvents).toHaveLength(1);
		expect(otherKeyboardState.inputEvents).toHaveLength(1);
		await pressShortcut();
		expect(keyboardState.shortcutCalls).toBe(1);
		expect(otherKeyboardState.shortcutCalls).toBe(1);

		environment.runtime.disablePlugin(
			"plugin_ui_fixture",
			"disabled by keyboard owner cleanup test"
		);
		const firstPluginInputCount = keyboardState.inputEvents.length;
		const otherPluginInputCount = otherKeyboardState.inputEvents.length;
		await pressX();
		expect(keyboardState.inputEvents).toHaveLength(firstPluginInputCount);
		expect(otherKeyboardState.inputEvents).toHaveLength(
			otherPluginInputCount + 1
		);
		await pressShortcut();
		expect(keyboardState.shortcutCalls).toBe(1);
		expect(otherKeyboardState.shortcutCalls).toBe(2);

		await environment.executeCommand(
			"plugin_ui_other_fixture",
			"stop-other-terminal-input"
		);
		const unsubscribedInputCount = otherKeyboardState.inputEvents.length;
		await pressX();
		expect(otherKeyboardState.inputEvents).toHaveLength(unsubscribedInputCount);
	} finally {
		await environment.dispose();
	}
});

test("custom UI focus and visibility are independent and do not settle the request", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-overlay"
		);
		await flushTestRenderer(environment.setup, 2);
		const presentationHandle =
			environment.customUIState.lastContext?.presentationHandle;
		if (presentationHandle === undefined) {
			throw new Error(
				"The custom overlay did not receive its presentation handle."
			);
		}
		let settled = false;
		void result.then(() => {
			settled = true;
		});

		await act(() => presentationHandle.unfocus());
		await flushTestRenderer(environment.setup, 2);
		expect(presentationHandle.isFocused()).toBe(false);
		expect(presentationHandle.isHidden()).toBe(false);
		expect(environment.customUIState.lastPresentationState).toMatchObject({
			focused: false,
			hidden: false,
			presentation: "overlay",
		});
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(settled).toBe(false);

		await act(() => presentationHandle.setHidden(true));
		await flushTestRenderer(environment.setup, 2);
		expect(presentationHandle.isFocused()).toBe(false);
		expect(presentationHandle.isHidden()).toBe(true);
		expect(environment.customUIState.lastPresentationState).toMatchObject({
			focused: false,
			hidden: true,
		});
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		expect(settled).toBe(false);

		await act(() => presentationHandle.focus());
		await flushTestRenderer(environment.setup, 2);
		expect(presentationHandle.isFocused()).toBe(true);
		expect(presentationHandle.isHidden()).toBe(true);
		expect(environment.customUIState.lastPresentationState).toMatchObject({
			focused: true,
			hidden: true,
		});
		expect(settled).toBe(false);

		await act(() => presentationHandle.setHidden(false));
		await flushTestRenderer(environment.setup, 2);
		expect(presentationHandle.isFocused()).toBe(true);
		expect(presentationHandle.isHidden()).toBe(false);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(settled).toBe(false);

		await act(() => presentationHandle.unfocus());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		await act(() => presentationHandle.focus());
		await flushTestRenderer(environment.setup, 2);
		expect(presentationHandle.isFocused()).toBe(true);
		expect(presentationHandle.isHidden()).toBe(false);
		expect(settled).toBe(false);

		await environment.pressEscape();
		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		await act(() => environment.setup.mockInput.typeText("restored focus"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("restored focus");
	} finally {
		await environment.dispose();
	}
});

test("custom UI cannot mutate the host composer keybindings", async () => {
	const environment = await pluginUiTestEnvironment();
	const expectedBindings = CHAT_TEXT_AREA_KEY_BINDINGS.map((binding) => ({
		...binding,
	}));
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		const composerBindings =
			environment.customUIState.lastContext?.keybindings.composer;
		if (composerBindings === undefined) {
			throw new Error("The custom UI did not receive composer bindings.");
		}

		expect(composerBindings).toEqual(expectedBindings);
		expect(composerBindings).not.toBe(CHAT_TEXT_AREA_KEY_BINDINGS);
		expect(Object.isFrozen(composerBindings)).toBe(true);
		for (const [index, binding] of composerBindings.entries()) {
			expect(binding).not.toBe(CHAT_TEXT_AREA_KEY_BINDINGS[index]);
			expect(Object.isFrozen(binding)).toBe(true);
		}
		expect(
			Reflect.set(composerBindings, "0", { name: "x", action: "delete" })
		).toBe(false);
		const firstBinding = composerBindings[0];
		if (firstBinding === undefined) {
			throw new Error("The custom UI received no composer keybindings.");
		}
		expect(Reflect.set(firstBinding, "action", "delete")).toBe(false);
		expect(CHAT_TEXT_AREA_KEY_BINDINGS).toEqual(expectedBindings);

		await environment.pressEscape();
		expect(await result).toBe("undefined");
	} finally {
		await environment.dispose();
	}
});

test("Interactive Mode binds the custom editor host for its mounted Session and releases it on unmount", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {}, true);
	try {
		const { result: firstRequest } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		await environment.pressEscape();
		expect(await firstRequest).toBe("undefined");
		await act(() => environment.setCustomEditorMounted(false));

		const { result: unboundRequest } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		expect(await unboundRequest).toBe("undefined");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);

		await act(() => environment.setCustomEditorMounted(true));
		const { result: reboundRequest } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		await environment.pressEscape();
		expect(await reboundRequest).toBe("undefined");
	} finally {
		await environment.dispose();
	}
});

test("the verified author example opens a React editor and returns its response", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"custom_editor",
			"reply-editor"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Reply to the current message"
		);
		expect(environment.setup.captureCharFrame()).toContain("Enter:");

		await act(() => environment.setup.mockInput.typeText("Example response"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);
		expect(await result).toBe("Example response");
	} finally {
		await environment.dispose();
	}
});

test("the author example returns responses from its overlay and full-screen commands", async () => {
	for (const [command, composerVisible] of [
		["reply-overlay", true],
		["reply-full-screen", false],
	] as const) {
		const environment = await pluginUiTestEnvironment();
		try {
			const { result } = await environment.executeCommand(
				"custom_editor",
				command
			);
			await flushTestRenderer(environment.setup, 2);
			const frame = environment.setup.captureCharFrame();
			expect(frame).toContain("Reply to the current message");
			expect(frame.includes("Fixture composer")).toBe(composerVisible);

			await act(() => environment.setup.mockInput.typeText("Example response"));
			await act(() => environment.setup.mockInput.pressEnter());
			await flushTestRenderer(environment.setup, 2);
			expect(await result).toBe("Example response");
			expect(environment.setup.captureCharFrame()).toContain(
				"Fixture composer"
			);
		} finally {
			await environment.dispose();
		}
	}
});

test("moving the composer caret refreshes completion before accepting a suggestion", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		true,
		[],
		undefined,
		false,
		true
	);
	try {
		const ui = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		const completionCursorOffsets: number[] = [];
		await act(() => {
			ui.addAutocompleteProvider((current) => ({
				...current,
				getSuggestions(context) {
					completionCursorOffsets.push(context.cursorOffset);
					const prefix =
						context.text
							.slice(0, context.cursorOffset)
							.match(completionPrefixPattern)?.[0] ?? "";
					return prefix.length === 0
						? current.getSuggestions(context)
						: {
								items: [{ label: `Choose ${prefix}`, value: "CHOSEN" }],
								prefix,
							};
				},
				applyCompletion(context, item, prefix) {
					const start = context.cursorOffset - prefix.length;
					const text = `${context.text.slice(0, start)}${item.value}${context.text.slice(context.cursorOffset)}`;
					return { cursorOffset: start + item.value.length, text };
				},
			}));
		});

		await act(() => environment.setup.mockInput.typeText("alpha beta"));
		await act(async () => flushTestRenderer(environment.setup, 2));
		await act(async () => {
			await environment.setup.mockMouse.click(7, 2);
			environment.setup.mockInput.pressArrow("left");
		});
		await act(async () => flushTestRenderer(environment.setup, 3));
		expect(completionCursorOffsets).toContain(4);
		expect(environment.setup.captureCharFrame()).toContain("Choose alph");
		await act(() => environment.setup.mockInput.pressEnter());
		await act(async () => flushTestRenderer(environment.setup, 2));

		expect(ui.getEditorText()).toBe("CHOSENa beta");
	} finally {
		await environment.dispose();
	}
});

test("custom editor exposes real composer submit, history, configured keys, and theme", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		true,
		[],
		undefined,
		false,
		true
	);
	try {
		const ui = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		let registered: PluginUIContributionResult | undefined;
		await act(async () => {
			registered = ui.setEditorComponent(environment.realComposerEditor);
			await flushTestRenderer(environment.setup, 2);
		});
		expect(registered).toEqual({ success: true });
		expect(environment.setup.captureCharFrame()).toContain(
			"Real composer theme: opencode"
		);

		const editorContext = environment.realComposerState.context;
		if (editorContext === undefined) {
			throw new Error(
				"The custom editor did not receive the real composer context."
			);
		}
		expect(editorContext.keybindings).toEqual(CHAT_TEXT_AREA_KEY_BINDINGS);
		await act(async () => {
			expect(ui.setEditorText("wrapped editor draft")).toBe(true);
			await flushTestRenderer(environment.setup, 2);
		});
		await act(async () => {
			environment.setup.mockInput.pressArrow("up");
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.realComposerState.context?.cursorOffset).toBe(0);
		await act(async () => {
			environment.setup.mockInput.pressArrow("down");
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.realComposerState.context?.cursorOffset).toBe(
			"wrapped editor draft".length
		);
		await act(async () => {
			expect(ui.setEditorText("")).toBe(true);
			await flushTestRenderer(environment.setup, 2);
		});
		let previousPromptConsumed = false;
		await act(() => {
			previousPromptConsumed = editorContext.previousPrompt();
		});
		expect(previousPromptConsumed).toBe(true);
		expect(ui.getEditorText()).toBe("real composer history");
		let nextPromptConsumed = false;
		await act(() => {
			nextPromptConsumed = editorContext.nextPrompt();
		});
		expect(nextPromptConsumed).toBe(true);
		expect(ui.getEditorText()).toBe("");

		await act(() => {
			expect(ui.setEditorText("submitted through PluginEditorContext")).toBe(
				true
			);
		});
		await act(async () => editorContext.submit());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.realComposerState.submittedTexts).toEqual([
			"submitted through PluginEditorContext",
		]);

		await act(() => {
			expect(ui.setTheme("one-dark")).toEqual({ success: true });
		});
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Real composer theme: one-dark"
		);
	} finally {
		await environment.dispose();
	}
});

test("replacement Plugin editors keep ordinary Up and Down keys for local navigation", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		true,
		[],
		undefined,
		false,
		true
	);
	try {
		const ui = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		await act(async () => {
			environment.setup.mockInput.typeText("hello");
			await flushTestRenderer(environment.setup, 2);
			expect(ui.setEditorComponent(LocalNavigationPluginEditor)).toEqual({
				success: true,
			});
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.setup.captureCharFrame()).toContain(
			"Local editor line 1; host cursor 5"
		);

		await act(async () => {
			environment.setup.mockInput.pressArrow("up");
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.setup.captureCharFrame()).toContain(
			"Local editor line 0; host cursor 5"
		);
	} finally {
		await environment.dispose();
	}
});

test("restoring the host editor after Plugin unload preserves Enter submission", async () => {
	const environment = await pluginUiTestEnvironment(
		"interactive",
		{},
		true,
		[],
		undefined,
		false,
		true
	);
	const replacementEditor: PluginEditorComponent = () => (
		<box>
			<text>Replacement editor without the host slot</text>
		</box>
	);
	try {
		const ui = environment.runtime.getPluginUI(
			"plugin_ui_fixture",
			environment.sessionId
		);
		await act(async () => {
			expect(ui.setEditorComponent(replacementEditor)).toEqual({
				success: true,
			});
			await flushTestRenderer(environment.setup, 2);
		});
		expect(environment.setup.captureCharFrame()).toContain(
			"Replacement editor without the host slot"
		);

		await act(async () => {
			environment.runtime.disablePlugin(
				"plugin_ui_fixture",
				"fixture editor unloaded"
			);
			await flushTestRenderer(environment.setup, 2);
		});
		await act(() =>
			environment.setup.mockInput.typeText("submit after Plugin unload")
		);
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);

		expect(environment.realComposerState.submittedTexts).toEqual([
			"submit after Plugin unload",
		]);
	} finally {
		await environment.dispose();
	}
});

test("custom editor preserves the live composer draft and transcript through restoration", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		await act(() => environment.setup.mockInput.typeText("existing draft"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("existing draft");

		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		await act(() => environment.transcriptState.advance());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI host fixture · update 1"
		);
		const { result: themeChange } = await environment.executeCommand(
			"plugin_ui_fixture",
			"theme"
		);
		expect(JSON.parse((await themeChange) ?? "{}")).toMatchObject({
			changed: { success: true },
			loaded: "one-dark",
		});
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"one-dark:64x16:6:interactive"
		);

		await environment.pressEscape();
		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI host fixture · update 1"
		);
		expect(environment.setup.captureCharFrame()).toContain("existing draft");
		await act(() => environment.setup.mockInput.typeText(" restored"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"existing draft restored"
		);
	} finally {
		await environment.dispose();
	}
});

test("Agent Turn completion continues behind full-screen custom UI and restores current state", async () => {
	const environment = await pluginUiTestEnvironment();
	const recorder = createFakeProviderRecorder();
	recorder.stepScript = async function* () {
		yield { delta: "Fresh provider response", type: "text-delta" };
		yield { completion: { kind: "completed" }, type: "finish" };
	};
	let agentSession: OpenedPluginUITestAgentSession | undefined;
	let stopObservingSession: (() => void) | undefined;
	let stopObservingTurn: (() => void) | undefined;
	try {
		await act(() => environment.setup.mockInput.typeText("preserved draft"));
		await flushTestRenderer(environment.setup, 2);
		const { result: customResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-full-screen"
		);
		await flushTestRenderer(environment.setup, 2);
		const fullScreenContext = environment.customUIState.lastContext;
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture composer"
		);
		expect(fullScreenContext).toMatchObject({ height: 16, width: 64 });
		agentSession = await environment.openAgentSession(recorder);
		const handle = agentSession.handle;
		await act(() => {
			stopObservingSession = handle.subscribe((snapshot) =>
				environment.transcriptState.showSessionTranscript(snapshot.transcript)
			);
		});
		const terminal = Promise.withResolvers<SessionSdkEvent>();
		stopObservingTurn = handle.onEvent((event) => {
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});

		await act(async () => {
			const admission = await handle.prompt({
				text: "Request fresh provider state.",
			});
			expect(admission.rejected).toBe(false);
			expect((await terminal.promise).type).toBe("agent-turn-completed");
		});
		await flushTestRenderer(environment.setup, 2);

		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fresh provider response"
		);
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(false);

		await environment.pressEscape();
		expect(await customResult).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		expect(environment.setup.captureCharFrame()).toContain("preserved draft");
		await act(() => environment.setup.mockInput.typeText(" restored"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"preserved draft restored"
		);
		expect(environment.setup.captureCharFrame()).toContain(
			"Fresh provider response"
		);
	} finally {
		stopObservingSession?.();
		stopObservingTurn?.();
		await agentSession?.dispose();
		await environment.dispose();
	}
});

test("Plugin Tool progress updates the live transcript without dismissing a custom editor", async () => {
	const environment = await pluginUiTestEnvironment();
	const recorder = createFakeProviderRecorder();
	const progressToolCallId = toolCallId("plugin-ui-progress-tool-call");
	const progressToolResult =
		Promise.withResolvers<
			Extract<SessionSdkEvent, { type: "tool-call-finished" }>
		>();
	const terminal = Promise.withResolvers<SessionSdkEvent>();
	let agentSession: OpenedPluginUITestAgentSession | undefined;
	let stopObservingSession: (() => void) | undefined;
	let stopObservingTurn: (() => void) | undefined;
	let currentTranscript: readonly object[] = [];
	let progressResultReachedProvider = false;
	let editorVisibleWhenToolFinished = false;
	try {
		const { result: customResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		const customContext = environment.customUIState.lastContext;
		if (customContext === undefined) {
			throw new Error("The custom editor did not receive its context.");
		}

		await environment.configStore.setValue(
			environment.workspace,
			"global",
			["permission", "plugin:plugin_ui_fixture:ui_progress"],
			"allow"
		);
		agentSession = await environment.openAgentSession(recorder);
		const handle = agentSession.handle;
		recorder.stepScript = async function* (request) {
			const toolResult = request.messages
				.flatMap(({ content }) => content)
				.find(
					(part) =>
						part.type === "tool-result" &&
						part.toolCallId === progressToolCallId
				);
			if (toolResult?.type === "tool-result") {
				if (toolResult.output !== "progress completed") {
					throw new Error("The Agent Turn received an unexpected Tool result.");
				}
				progressResultReachedProvider = true;
				yield {
					delta: "Plugin Tool progress completed in the Agent Turn.",
					type: "text-delta",
				};
			} else {
				const progressTool = request.tools?.find(({ name }) =>
					name.endsWith("_ui_progress")
				);
				if (progressTool === undefined) {
					throw new Error("The Agent Turn did not receive ui_progress.");
				}
				yield {
					input: {},
					toolCallId: progressToolCallId,
					toolName: progressTool.name,
					type: "tool-call",
				};
			}
			yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
			yield { completion: { kind: "completed" }, type: "finish" };
		};
		await act(() => {
			stopObservingSession = handle.subscribe((snapshot) => {
				currentTranscript = snapshot.transcript;
				environment.transcriptState.showSessionTranscript(snapshot.transcript);
			});
		});
		stopObservingTurn = handle.onEvent((event) => {
			if (
				event.type === "tool-call-finished" &&
				event.toolCallId === progressToolCallId
			) {
				progressToolResult.resolve(event);
				editorVisibleWhenToolFinished = environment.isCustomLayerTop();
			}
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});

		await act(async () => {
			const admission = await handle.prompt({
				text: "Ask the Agent to report progress through its Plugin Tool.",
			});
			expect(admission.rejected).toBe(false);
			expect((await terminal.promise).type).toBe("agent-turn-completed");
			expect((await progressToolResult.promise).outcome).toMatchObject({
				output: "progress completed",
				type: "success",
			});
		});
		await flushTestRenderer(environment.setup, 2);

		const progressPart = sessionMessagesFromTranscript(currentTranscript)
			.flatMap(({ parts }) => parts)
			.find(
				(part) =>
					part.type === "dynamic-tool" && part.toolCallId === progressToolCallId
			);
		expect(progressPart).toMatchObject({
			output: "progress completed",
			state: "output-available",
		});
		expect(progressResultReachedProvider).toBe(true);
		expect(editorVisibleWhenToolFinished).toBe(true);
		expect(environment.customUIState.lastContext).toBe(customContext);
		expect(customContext.signal.aborted).toBe(false);
		expect(textFromSessionTranscript(currentTranscript)).toContain(
			"Plugin Tool progress completed in the Agent Turn."
		);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.setup.captureCharFrame()).toContain(
			"Tool progress completed in the Agent Turn."
		);

		await environment.pressEscape();
		expect(await customResult).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
	} finally {
		stopObservingSession?.();
		stopObservingTurn?.();
		await agentSession?.dispose();
		await environment.dispose();
	}
});

test("Agent Turn interruption leaves custom editor open and restores the live transcript", async () => {
	const environment = await pluginUiTestEnvironment();
	const recorder = createFakeProviderRecorder();
	const providerStarted = Promise.withResolvers<void>();
	const providerOutput = Promise.withResolvers<void>();
	recorder.stepScript = async function* (_request, _recorder, signal) {
		yield { delta: "Partial provider response", type: "text-delta" };
		providerStarted.resolve();
		if (signal === undefined) {
			throw new Error(
				"The fake Provider did not receive the Agent Turn signal."
			);
		}
		const aborted = Promise.withResolvers<void>();
		const onAbort = () => aborted.resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
		await aborted.promise;
		throw signal.reason ?? new DOMException("Interrupted", "AbortError");
	};
	let agentSession: OpenedPluginUITestAgentSession | undefined;
	let stopObservingSession: (() => void) | undefined;
	let stopObservingTurn: (() => void) | undefined;
	try {
		const { result: customResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		agentSession = await environment.openAgentSession(recorder);
		const handle = agentSession.handle;
		await act(() => {
			stopObservingSession = handle.subscribe((snapshot) =>
				environment.transcriptState.showSessionTranscript(snapshot.transcript)
			);
		});
		const terminal = Promise.withResolvers<SessionSdkEvent>();
		stopObservingTurn = handle.onEvent((event) => {
			if (event.type === "text-delta") {
				providerOutput.resolve();
			}
			if (
				event.type === "agent-turn-completed" ||
				event.type === "agent-turn-failed" ||
				event.type === "agent-turn-cancelled" ||
				event.type === "agent-turn-interrupted"
			) {
				terminal.resolve(event);
			}
		});

		await act(async () => {
			const admission = await handle.prompt({
				text: "Request interruptible provider state.",
			});
			expect(admission.rejected).toBe(false);
			await providerStarted.promise;
			await providerOutput.promise;
		});
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(false);
		await act(async () => {
			await handle.interrupt();
			expect((await terminal.promise).type).toBe("agent-turn-interrupted");
		});
		await flushTestRenderer(environment.setup, 2);

		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(false);
		expect(environment.setup.captureCharFrame()).toContain(
			"Request interruptible provider state."
		);

		await environment.pressEscape();
		expect(await customResult).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		expect(environment.setup.captureCharFrame()).toContain(
			"Request interruptible provider state."
		);
	} finally {
		stopObservingSession?.();
		stopObservingTurn?.();
		await agentSession?.dispose();
		await environment.dispose();
	}
});

test("custom UI receives resized dimensions without losing keyboard dismissal", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		height: 8,
		width: 18,
	});
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.customUIState.lastComponentDimensions).toEqual({
			height: 8,
			width: 18,
		});

		await act(() => environment.setup.resize(22, 10));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.customUIState.lastComponentDimensions).toEqual({
			height: 10,
			width: 22,
		});
		await environment.pressEscape();
		expect(await result).toBe("undefined");
	} finally {
		await environment.dispose();
	}
});

test("overlay is painted at its terminal-cell bounds and resizes with the terminal", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		height: 8,
		width: 18,
	});
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-overlay"
		);
		await flushTestRenderer(environment.setup, 2);
		const context = environment.customUIState.lastContext;
		if (context === undefined) {
			throw new Error("The custom overlay did not receive its context.");
		}
		const panelBackground = RGBA.fromHex(
			context.theme.colors.backgroundElement
		);

		expect(
			getRenderedBackgroundBounds(
				environment.setup.captureSpans(),
				panelBackground
			)
		).toEqual({ cellCount: 56, height: 4, left: 2, top: 2, width: 14 });

		await act(() => environment.setup.resize(22, 10));
		await flushTestRenderer(environment.setup, 2);
		expect(
			getRenderedBackgroundBounds(
				environment.setup.captureSpans(),
				panelBackground
			)
		).toEqual({ cellCount: 108, height: 6, left: 2, top: 2, width: 18 });

		await environment.pressEscape();
		expect(await result).toBe("undefined");
	} finally {
		await environment.dispose();
	}
});

test("overlay and full-screen component bounds track terminal resize", async () => {
	for (const [command, isOverlay] of [
		["custom-overlay", true],
		["custom-full-screen", false],
	] as const) {
		const environment = await pluginUiTestEnvironment("interactive", {
			height: 8,
			width: 18,
		});
		try {
			const { result } = await environment.executeCommand(
				"plugin_ui_fixture",
				command
			);
			await flushTestRenderer(environment.setup, 2);
			const initialDimensions =
				environment.customUIState.lastComponentDimensions;
			const presentationHandle =
				environment.customUIState.lastContext?.presentationHandle;
			if (presentationHandle === undefined) {
				throw new Error(`${command} did not receive its presentation handle.`);
			}
			if (initialDimensions === undefined) {
				throw new Error(`${command} did not render its component.`);
			}
			expect(initialDimensions.width).toBeLessThanOrEqual(18);
			expect(initialDimensions.height).toBeLessThanOrEqual(8);
			expect(presentationHandle.getBounds()).toEqual(
				isOverlay
					? { left: 2, top: 2, width: 14, height: 4 }
					: { left: 0, top: 0, width: 18, height: 8 }
			);
			if (!isOverlay) {
				expect(initialDimensions).toEqual({ height: 8, width: 18 });
			}

			await act(() => environment.setup.resize(22, 10));
			await flushTestRenderer(environment.setup, 2);
			const resizedDimensions =
				environment.customUIState.lastComponentDimensions;
			if (resizedDimensions === undefined) {
				throw new Error(`${command} lost its component during resize.`);
			}
			expect(resizedDimensions.width).toBeLessThanOrEqual(22);
			expect(resizedDimensions.height).toBeLessThanOrEqual(10);
			expect(resizedDimensions.width).toBeGreaterThan(initialDimensions.width);
			expect(resizedDimensions.height).toBeGreaterThan(
				initialDimensions.height
			);
			expect(presentationHandle.getBounds()).toEqual(
				isOverlay
					? { left: 2, top: 2, width: 18, height: 6 }
					: { left: 0, top: 0, width: 22, height: 10 }
			);

			await environment.pressEscape();
			expect(await result).toBe("undefined");
		} finally {
			await environment.dispose();
		}
	}
});

test("reserved Ctrl+C reclaims the composer without terminating the host", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		expect(environment.isCustomLayerTop()).toBe(true);

		await environment.pressReclaim();
		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		const { result: hostStillActive } = await environment.executeCommand(
			"plugin_ui_fixture",
			"notify"
		);
		expect(await hostStillActive).toBe("notified");
	} finally {
		await environment.dispose();
	}
});

test("overlay and full-screen UI reserve Ctrl+C for host reclamation", async () => {
	for (const command of ["custom-overlay", "custom-full-screen"] as const) {
		const environment = await pluginUiTestEnvironment();
		try {
			const { result } = await environment.executeCommand(
				"plugin_ui_fixture",
				command
			);
			await flushTestRenderer(environment.setup, 2);
			expect(environment.setup.captureCharFrame()).toContain(
				"Fixture custom UI"
			);
			expect(environment.isCustomLayerTop()).toBe(true);

			await environment.pressReclaim();
			expect(await result).toBe("undefined");
			expect(environment.setup.captureCharFrame()).toContain(
				"Fixture composer"
			);
			expect(environment.setup.captureCharFrame()).not.toContain(
				"Fixture custom UI"
			);
			const { result: hostStillActive } = await environment.executeCommand(
				"plugin_ui_fixture",
				"notify"
			);
			expect(await hostStillActive).toBe("notified");
		} finally {
			await environment.dispose();
		}
	}
});

test("renderer teardown aborts and settles every custom UI presentation", async () => {
	for (const command of [
		"custom",
		"custom-overlay",
		"custom-full-screen",
	] as const) {
		const environment = await pluginUiTestEnvironment();
		try {
			const { result } = await environment.executeCommand(
				"plugin_ui_fixture",
				command
			);
			await flushTestRenderer(environment.setup, 2);
			await act(async () => environment.destroyRenderer());

			expect(await result).toBe("undefined");
			expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);
			expect(environment.pluginUIHost?.getCustomUI()).toBeNull();
		} finally {
			await environment.dispose();
		}
	}
});

test("late done calls cannot settle or replace a subsequent custom UI interaction", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: firstResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		const firstContext = environment.customUIState.lastContext;
		if (firstContext === undefined) {
			throw new Error(
				"The first custom UI factory did not receive its context."
			);
		}
		await act(() => {
			firstContext.done("first result");
			firstContext.done("duplicate result");
		});
		await flushTestRenderer(environment.setup, 2);
		expect(await firstResult).toBe("first result");

		const { result: secondResult } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		await act(() => firstContext.done("stale result"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		const secondContext = environment.customUIState.lastContext;
		if (secondContext === undefined || secondContext === firstContext) {
			throw new Error(
				"The next custom UI factory did not receive a fresh context."
			);
		}
		await act(() => secondContext.done("second result"));
		expect(await secondResult).toBe("second result");
	} finally {
		await environment.dispose();
	}
});

test("event-originated custom UI asks for fresh consent before factory execution", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const initialFactoryCalls = environment.customUIState.factoryCalls;
		const result = environment.executeCustomTool();
		await flushTestRenderer(environment.setup, 2);

		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI invitation"
		);
		expect(environment.setup.captureCharFrame()).toContain(
			"Fixture event custom UI"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);
		expect(environment.customUIState.factoryCalls).toBe(initialFactoryCalls);

		await act(() => environment.setup.mockInput.pressArrow("up"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		await act(() => environment.setup.mockInput.typeText("consented response"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toMatchObject({
			output: "consented response",
			type: "success",
		});
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);

		const nextRequest = environment.executeCustomTool();
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI invitation"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);
		expect(environment.customUIState.factoryCalls).toBe(
			initialFactoryCalls + 1
		);
		await environment.pressEscape();
		expect(await nextRequest).toMatchObject({
			output: "undefined",
			type: "success",
		});
	} finally {
		await environment.dispose();
	}
});

test("overlay and full-screen event requests wait for consent before mounting", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		for (const [toolName, presentation] of [
			["ui_custom_overlay", "overlay"],
			["ui_custom_full_screen", "full-screen"],
		] as const) {
			const initialFactoryCalls = environment.customUIState.factoryCalls;
			const pending = environment.executePluginTool(
				toolName,
				`plugin-ui-${presentation}-consent`
			);
			await flushTestRenderer(environment.setup, 2);
			const invitationFrame = environment.setup.captureCharFrame();
			expect(invitationFrame).toContain("Plugin UI invitation");
			expect(invitationFrame).not.toContain("Fixture custom UI");
			expect(environment.customUIState.factoryCalls).toBe(initialFactoryCalls);

			await act(() => environment.setup.mockInput.pressArrow("up"));
			await act(() => environment.setup.mockInput.pressEnter());
			await flushTestRenderer(environment.setup, 2);
			const activeFrame = environment.setup.captureCharFrame();
			expect(activeFrame).toContain("Fixture custom UI");
			expect(activeFrame.includes("Fixture composer")).toBe(
				presentation === "overlay"
			);
			await environment.pressEscape();
			expect(await pending).toMatchObject({
				output: "undefined",
				type: "success",
			});
		}
	} finally {
		await environment.dispose();
	}
});

test("declining an event-originated custom UI resolves undefined and releases admission", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const initialFactoryCalls = environment.customUIState.factoryCalls;
		const declined = environment.executeCustomTool();
		await flushTestRenderer(environment.setup, 2);
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);

		expect(await declined).toMatchObject({
			output: "undefined",
			type: "success",
		});
		expect(environment.customUIState.factoryCalls).toBe(initialFactoryCalls);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture custom UI"
		);

		const accepted = environment.executeCustomTool();
		await flushTestRenderer(environment.setup, 2);
		await act(() => environment.setup.mockInput.pressArrow("up"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		await act(() => environment.setup.mockInput.pressEscape());
		await flushTestRenderer(environment.setup, 2);
		expect(await accepted).toMatchObject({
			output: "undefined",
			type: "success",
		});
	} finally {
		await environment.dispose();
	}
});

test("a pending invitation owns the host-wide admission slot across Plugins", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const pending = environment.executeCustomTool();
		await flushTestRenderer(environment.setup, 2);

		const { result: competingCommand } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other-custom-busy"
		);
		expect(await competingCommand).toBe("plugin_ui_custom_busy");
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI invitation"
		);

		await act(() => environment.setup.mockInput.pressArrow("up"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");
		const { result: mountedCompetingCommand } =
			await environment.executeCommand(
				"plugin_ui_other_fixture",
				"other-custom-busy"
			);
		expect(await mountedCompetingCommand).toBe("plugin_ui_custom_busy");
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		await environment.pressEscape();
		expect(await pending).toMatchObject({
			output: "undefined",
			type: "success",
		});
	} finally {
		await environment.dispose();
	}
});

test("factory and component failures reject with stable codes and release the slot", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: factoryFailure } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-factory-failure"
		);
		expect(await factoryFailure).toBe("plugin_ui_custom_failed");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");

		const { result: componentFailure } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-component-failure"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(await componentFailure).toBe("plugin_ui_custom_failed");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");

		const { result: fullScreenComponentFailure } =
			await environment.executeCommand(
				"plugin_ui_fixture",
				"custom-full-screen-component-failure"
			);
		await flushTestRenderer(environment.setup, 2);
		expect(await fullScreenComponentFailure).toBe("plugin_ui_custom_failed");
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
		expect(environment.pluginUIHost?.getCustomUI()).toBeNull();

		environment.customUIState.throwComponent = false;
		const { result: recovered } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		await act(() => environment.setup.mockInput.typeText("recovered response"));
		await act(() => environment.setup.mockInput.pressEnter());
		expect(await recovered).toBe("recovered response");
	} finally {
		await environment.dispose();
	}
});

test("view replacement aborts custom UI and ignores a late async factory result", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom-late-factory"
		);
		await environment.customUIState.factoryStarted;
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Loading custom Plugin UI"
		);

		await act(() => environment.unbindPluginUIHost());
		await flushTestRenderer(environment.setup, 2);
		expect(await result).toBe("undefined");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);

		environment.customUIState.resolveAsyncFactory(() => (
			<text>Late custom UI</text>
		));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Late custom UI"
		);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");

		await act(() =>
			environment.runtime.bindPluginUIHost(
				environment.sessionId,
				environment.pluginUIHost
			)
		);
		const { result: nextRequest } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		await act(() => environment.setup.mockInput.pressEnter());
		expect(await nextRequest).toBe("");
	} finally {
		await environment.dispose();
	}
});

test("Plugin runtime shutdown cancels custom UI before unloading the Plugin", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		await act(async () => environment.runtime.shutdown());
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("undefined");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
	} finally {
		await environment.dispose();
	}
});

test("Plugin disable aborts mounted custom UI and restores the host editor", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_fixture",
				"Plugin disabled for custom UI lifecycle test."
			)
		);
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("undefined");
		expect(environment.customUIState.lastContext?.signal.aborted).toBe(true);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
	} finally {
		await environment.dispose();
	}
});

test("custom UI leaves the live transcript region mounted while replacing the editor", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"custom"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI host fixture"
		);
		expect(environment.setup.captureCharFrame()).toContain("Fixture custom UI");

		await environment.pressEscape();
		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain(
			"Plugin UI host fixture · update 0"
		);
		expect(environment.setup.captureCharFrame()).toContain("Fixture composer");
	} finally {
		await environment.dispose();
	}
});

test("a public Plugin Command selects a host-rendered option with the keyboard", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"select"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Choose a fixture option"
		);

		await act(() => environment.setup.mockInput.pressArrow("down"));
		await act(() => environment.setup.mockInput.pressEnter());
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("Beta");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Choose a fixture option"
		);
	} finally {
		await environment.dispose();
	}
});

test("Plugin Tool handlers receive host-rendered Plugin UI", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const tool = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			pluginRuntime: environment.runtime,
			pluginTools: environment.runtime.getToolDescriptors(
				environment.sessionId
			),
			sessionId: environment.sessionId,
			workspace: environment.workspace,
		}).find(({ definition }) => definition.name.includes("ui_input"));
		if (tool === undefined) {
			throw new Error("The fixture Plugin UI Tool was not registered.");
		}

		const result = tool.execute({
			input: {},
			toolCallId: toolCallId("plugin-ui-input-tool"),
		});
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Tool UI input");
		await act(() => environment.setup.mockInput.typeText("tool response"));
		await act(() => environment.setup.mockInput.pressEnter());

		expect(await result).toMatchObject({
			output: "tool response",
			type: "success",
		});
	} finally {
		await environment.dispose();
	}
});

test("Plugin UI dismissal and timeout use each dialog's documented default", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: select } = await environment.executeCommand(
			"plugin_ui_fixture",
			"select"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressEscape();
		expect(await select).toBe("dismissed");

		const { result: confirm } = await environment.executeCommand(
			"plugin_ui_fixture",
			"confirm"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressEscape();
		expect(await confirm).toBe("cancelled");

		const { result: input } = await environment.executeCommand(
			"plugin_ui_fixture",
			"input"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressEscape();
		expect(await input).toBe("undefined");

		const { result: editor } = await environment.executeCommand(
			"plugin_ui_fixture",
			"editor"
		);
		await flushTestRenderer(environment.setup, 2);
		await environment.pressEscape();
		expect(await editor).toBe("undefined");
	} finally {
		await environment.dispose();
	}
});

test("Plugin editor saves the edited text with Ctrl+Enter", async () => {
	const environment = await pluginUiTestEnvironment("interactive", {
		kittyKeyboard: true,
	});
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"editor-save"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture editor");
		await act(() => environment.setup.mockInput.typeText("Saved draft"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Saved draft");
		await act(() => environment.setup.mockInput.pressEnter({ ctrl: true }));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Fixture editor"
		);

		expect(await result).toBe("Saved draft");
	} finally {
		await environment.dispose();
	}
});

test("Plugin UI timeouts resolve select, confirm, input, and editor defaults", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		for (const [command, expected] of [
			["timeout-select", "undefined"],
			["timeout-confirm", "false"],
			["timeout-input", "undefined"],
			["timeout-editor", "undefined"],
		] as const) {
			const { result } = await environment.executeCommand(
				"plugin_ui_fixture",
				command
			);
			const outcome = { value: "" };
			await act(async () => {
				outcome.value = (await result) ?? "undefined";
			});
			await flushTestRenderer(environment.setup, 2);
			expect(outcome.value).toBe(expected);
		}
		expect(environment.setup.captureCharFrame()).not.toContain("Timed");
	} finally {
		await environment.dispose();
	}
});

test("caller abort resolves its Plugin UI request and removes its dialog", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"input-abort"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Abortable input");

		const abortResource = environment.runtime.getResource<{
			abort: () => void;
			controller: AbortController;
		}>("plugin_ui_fixture", "input_abort");
		if (abortResource === undefined) {
			throw new Error("The input abort resource was not registered.");
		}
		await act(() => abortResource.abort());
		await flushTestRenderer(environment.setup, 2);

		expect(abortResource.controller.signal.aborted).toBe(true);
		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Abortable input"
		);
	} finally {
		await environment.dispose();
	}
});

test("timing out a child Plugin dialog leaves its parent flow active", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"nested-timeout"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Inner prompt");

		const nestedPromptResult = environment.runtime.getResource<
			Promise<boolean>
		>("plugin_ui_fixture", "nested_prompt_result");
		if (nestedPromptResult === undefined) {
			throw new Error("The nested Plugin prompt result was not registered.");
		}
		let childResult: boolean | undefined;
		await act(async () => {
			childResult = await nestedPromptResult;
		});
		expect(childResult).toBe(false);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Parent prompt");
		expect(environment.setup.captureCharFrame()).not.toContain("Inner prompt");

		await act(() => environment.setup.mockInput.typeText("parent value"));
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("parent value");
		await act(() => environment.setup.mockInput.pressEnter());
		expect(await result).toBe("false:parent value");

		const promptEvents = environment.runtime.getResource<string[]>(
			"plugin_ui_fixture",
			"prompt_events"
		);
		if (promptEvents === undefined) {
			throw new Error(
				"The nested prompt lifecycle events were not registered."
			);
		}
		expect(promptEvents.filter((event) => event.startsWith("start:"))).toEqual([
			"start:input:Parent prompt",
		]);
		expect(promptEvents.filter((event) => event.startsWith("end:"))).toEqual([
			"end:input:Parent prompt",
		]);
	} finally {
		await environment.dispose();
	}
});

test("overlapping Plugin prompts coalesce lifecycle notifications", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"overlapping-prompts"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Second prompt");

		await environment.pressEscape();
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).not.toContain("Second prompt");
		expect(environment.setup.captureCharFrame()).toContain("First prompt");
		await environment.pressEscape();
		await flushTestRenderer(environment.setup, 2);
		expect(await result).toBe("undefined:false");

		const promptEvents = environment.runtime.getResource<string[]>(
			"plugin_ui_fixture",
			"prompt_events"
		);
		if (promptEvents === undefined) {
			throw new Error("The prompt lifecycle events were not registered.");
		}
		expect(promptEvents.filter((event) => event.startsWith("start:"))).toEqual([
			"start:select:First prompt",
		]);
		expect(promptEvents.filter((event) => event.startsWith("end:"))).toEqual([
			"end:select:First prompt",
		]);
	} finally {
		await environment.dispose();
	}
});

test("prompt observer failures and pending callbacks do not block host dialogs", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: failedObserver } = await environment.executeCommand(
			"plugin_ui_fixture",
			"observer-failure"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Observer failure");
		await environment.pressEscape();
		expect(await failedObserver).toBe("cancelled");

		const { result: pendingObserver } = await environment.executeCommand(
			"plugin_ui_fixture",
			"observer-pending"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Observer does not block"
		);
		await environment.pressEscape();
		expect(await pendingObserver).toBe("cancelled");
	} finally {
		await environment.dispose();
	}
});

test("disabling a Plugin closes only its dialog in the shared host stack", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result: disabledPluginPrompt } = await environment.executeCommand(
			"plugin_ui_fixture",
			"input"
		);
		const { result: otherPluginPrompt } = await environment.executeCommand(
			"plugin_ui_other_fixture",
			"other_input"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain(
			"Other Plugin prompt"
		);

		await act(() =>
			environment.runtime.disablePlugin(
				"plugin_ui_fixture",
				"Plugin disabled for test."
			)
		);
		await flushTestRenderer(environment.setup, 2);

		expect(await disabledPluginPrompt).toBe("undefined");
		expect(environment.setup.captureCharFrame()).toContain(
			"Other Plugin prompt"
		);
		await act(() => environment.setup.mockInput.typeText("preserved"));
		await act(() => environment.setup.mockInput.pressEnter());
		expect(await otherPluginPrompt).toBe("preserved");
	} finally {
		await environment.dispose();
	}
});

test("unbinding a Session view cancels its Plugin UI request", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"input"
		);
		await flushTestRenderer(environment.setup, 2);
		expect(environment.setup.captureCharFrame()).toContain("Fixture input");

		await act(() => environment.unbindPluginUIHost());
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("undefined");
		expect(environment.setup.captureCharFrame()).not.toContain("Fixture input");
	} finally {
		await environment.dispose();
	}
});

test("Plugin theme changes update shared theme state without replacing local styles", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"theme"
		);
		const outcome = await result;
		if (outcome === undefined) {
			throw new Error("The Plugin theme command returned no result.");
		}
		expect(JSON.parse(outcome)).toMatchObject({
			changed: { success: true },
			count: expect.any(Number),
			invalid: { success: false },
			invalidClone: { error: expect.any(String), success: false },
			loaded: "one-dark",
		});
		await flushTestRenderer(environment.setup, 2);
		const frame = environment.setup.captureCharFrame();
		expect(frame).toContain("global:one-dark:");
		expect(frame).toContain("local:one-dark:#123456");
	} finally {
		await environment.dispose();
	}
});

test("JSON, Print, and RPC Plugins receive terminal-free UI defaults", async () => {
	for (const executionMode of ["json", "print", "rpc"] as const) {
		const environment = await pluginUiTestEnvironment(executionMode);
		if (executionMode === "rpc") {
			environment.unbindPluginUIHost();
		}
		try {
			const { result: select } = await environment.executeCommand(
				"plugin_ui_fixture",
				"select"
			);
			const { result: confirm } = await environment.executeCommand(
				"plugin_ui_fixture",
				"confirm"
			);
			const { result: input } = await environment.executeCommand(
				"plugin_ui_fixture",
				"input"
			);
			const { result: editor } = await environment.executeCommand(
				"plugin_ui_fixture",
				"editor"
			);
			const { result: notification } = await environment.executeCommand(
				"plugin_ui_fixture",
				"notify"
			);
			const keyboardState =
				environment.runtime.getResource<PluginKeyboardState>(
					"plugin_ui_fixture",
					"keyboard_state"
				);
			if (keyboardState === undefined) {
				throw new Error(
					"The keyboard fixture Plugin state was not registered."
				);
			}
			const initialShortcutCalls = keyboardState.shortcutCalls;
			const initialInputEvents = keyboardState.inputEvents.length;
			const { result: terminalInput } = await environment.executeCommand(
				"plugin_ui_fixture",
				"terminal-input-noop"
			);
			const { result: theme } = await environment.executeCommand(
				"plugin_ui_fixture",
				"theme"
			);
			const unsupportedUI = environment.runtime.getPluginUI(
				"plugin_ui_fixture",
				environment.sessionId
			);
			expect(unsupportedUI.getEditorText()).toBeUndefined();
			expect(unsupportedUI.setEditorText("ignored")).toBe(false);
			expect(unsupportedUI.pasteToEditor("ignored")).toBe(false);
			expect(unsupportedUI.getEditorComponent()).toBeUndefined();
			expect(
				unsupportedUI.setEditorComponent(WrappedPluginEditor)
			).toBeUndefined();
			const unregister = unsupportedUI.addAutocompleteProvider(
				(current) => current
			);
			unregister();
			expect(
				environment.pluginUIHost.getAutocompleteProviders(environment.sessionId)
			).toEqual([]);

			expect(await select).toBe("dismissed");
			expect(await confirm).toBe("cancelled");
			expect(await input).toBe("undefined");
			expect(await editor).toBe("undefined");
			const initialFactoryCalls = environment.customUIState.factoryCalls;
			const { result: custom } = await environment.executeCommand(
				"plugin_ui_fixture",
				"custom"
			);
			expect(await custom).toBe("undefined");
			expect(environment.customUIState.factoryCalls).toBe(initialFactoryCalls);
			expect(await notification).toBe("notified");
			expect(await terminalInput).toBe("terminal input disabled");
			await act(async () => {
				environment.setup.mockInput.pressKey("p", { ctrl: true });
				await flushTestRenderer(environment.setup, 2);
			});
			expect(keyboardState.shortcutCalls).toBe(initialShortcutCalls);
			expect(keyboardState.inputEvents).toHaveLength(initialInputEvents);
			keyboardState.stopInput?.();
			const { result: presentationDefaults } = await environment.executeCommand(
				"plugin_ui_fixture",
				"presentation-defaults"
			);
			expect(JSON.parse((await presentationDefaults) ?? "{}")).toEqual({
				expanded: false,
				footer: { success: true },
				header: { success: true },
			});
			expect(environment.uiUpdates).toEqual([]);
			const themeResult = JSON.parse((await theme) ?? "{}");
			expect(themeResult).toEqual({
				changed: {
					error: "Theme changes are available only in Interactive Mode.",
					success: false,
				},
				count: 0,
				invalid: {
					error: "Theme changes are available only in Interactive Mode.",
					success: false,
				},
			});
			expect(environment.setup.captureCharFrame()).not.toContain(
				"Fixture notification"
			);
			expect(environment.setup.captureCharFrame()).not.toContain(
				"Choose a fixture option"
			);
		} finally {
			await environment.dispose();
		}
	}
});

test("Plugin notifications render as nonblocking host toasts", async () => {
	const environment = await pluginUiTestEnvironment();
	try {
		const { result } = await environment.executeCommand(
			"plugin_ui_fixture",
			"notify"
		);
		await flushTestRenderer(environment.setup, 2);

		expect(await result).toBe("notified");
		expect(environment.setup.captureCharFrame()).toContain(
			"Fixture notification"
		);
		expect(environment.setup.captureCharFrame()).not.toContain(
			"Plugin Selection"
		);
	} finally {
		await environment.dispose();
	}
});
