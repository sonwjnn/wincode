import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CapturedFrame, type InputRenderable, RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { agentIdSchema, toModelId } from "@wincode/agent-core";
import type {
	PluginUICustomBounds,
	PluginUICustomComponent,
	PluginUICustomContext,
	PluginUICustomPresentationMode,
	SessionSdk,
	SessionSdkEvent,
	SessionSdkHandle,
} from "@wincode/coding-agent";
import { LocalStyleProvider } from "@wincode/tui";
import { act, useRef, useState } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import { createPluginTools } from "@/modules/plugins/tools";
import type { PluginUIHost } from "@/modules/plugins/ui/plugin-ui-host";
import {
	PluginUICustomPresentation,
	PluginUIHostProvider,
	usePluginUIHost,
} from "@/modules/plugins/ui/plugin-ui-host";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionMessage } from "@/modules/sessions/message";
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
import pluginUiFixture from "../fixtures/plugin-ui-fixture";
import pluginUiOtherFixture from "../fixtures/plugin-ui-other-fixture";
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

const pluginUiTestEnvironment = async (
	executionMode: ExecutionMode = "interactive",
	testRendererOptions: Readonly<{
		height?: number;
		kittyKeyboard?: boolean;
		width?: number;
	}> = {},
	bindPluginUIHostInEditor = false
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
	let isTopLayer: (id: string) => boolean = () => false;
	const transcriptState: {
		advance: () => void;
		showSessionTranscript: (transcript: readonly object[]) => void;
	} = {
		advance: () => undefined,
		showSessionTranscript: () => undefined,
	};
	const customEditorState: { setMounted: (mounted: boolean) => void } = {
		setMounted: () => undefined,
	};
	function CapturePluginUIHost() {
		pluginUIHost = usePluginUIHost();
		isTopLayer = useKeyboardLayer().isTopLayer;
		return null;
	}
	function TestTranscript() {
		const [revision, setRevision] = useState(0);
		const [sessionTranscript, setSessionTranscript] = useState<string>();
		transcriptState.advance = () => setRevision((current) => current + 1);
		transcriptState.showSessionTranscript = (transcript) =>
			setSessionTranscript(textFromSessionTranscript(transcript));
		return (
			<text>
				{sessionTranscript ?? `Plugin UI host fixture · update ${revision}`}
			</text>
		);
	}
	function FixtureComposer() {
		const inputRef = useRef<InputRenderable>(null);
		const [value, setValue] = useState("");
		const { isTopLayer } = useKeyboardLayer();
		return (
			<box flexDirection="column">
				<text>Fixture composer</text>
				<input
					focused={isTopLayer("base")}
					onContentChange={() => setValue(inputRef.current?.value ?? "")}
					ref={inputRef}
				/>
				<text>{value}</text>
			</box>
		);
	}
	function ThemeProbe({ label }: Readonly<{ label: string }>) {
		const { colors, currentTheme } = useTheme();
		return <text>{`${label}:${currentTheme.name}:${colors.primary}`}</text>;
	}
	function CustomEditorRegion() {
		const [mounted, setMounted] = useState(true);
		customEditorState.setMounted = setMounted;
		if (!mounted) {
			return <FixtureComposer />;
		}
		return (
			<PluginUICustomPresentation
				{...(bindPluginUIHostInEditor ? { pluginRuntime: runtime } : {})}
				sessionId={sessionId}
			>
				<FixtureComposer />
			</PluginUICustomPresentation>
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
	const setup = await testRender(
		<ThemeProvider themeName="opencode">
			<ToastProvider>
				<KeyboardLayerProvider>
					<DialogProvider>
						<PluginUIHostProvider>
							<CapturePluginUIHost />
							<TestTranscript />
							<CustomEditorRegion />
							<ThemeProbe label="global" />
							<LocalStyleProvider colors={{ primary: "#123456" }}>
								<ThemeProbe label="local" />
							</LocalStyleProvider>
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
		name: string
	): Promise<{ result: Promise<string | undefined> }> => {
		let result: Promise<string | undefined> | undefined;
		await act(async () => {
			result = runtime.executeCommand(pluginId, name, {
				argument: "",
				sessionId,
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
		setCustomEditorMounted: customEditorState.setMounted,
	};
};

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
			const { result: theme } = await environment.executeCommand(
				"plugin_ui_fixture",
				"theme"
			);

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
