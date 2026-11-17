import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { agentIdSchema } from "@wincode/agent-core";
import { LocalStyleProvider } from "@wincode/tui";
import { act } from "react";
import { loadPlugins } from "@/modules/plugins/loader";
import { createPluginTools } from "@/modules/plugins/tools";
import type { PluginUIHost } from "@/modules/plugins/ui/plugin-ui-host";
import {
	PluginUIHostProvider,
	usePluginUIHost,
} from "@/modules/plugins/ui/plugin-ui-host";
import { createConfigStore } from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import {
	ThemeProvider,
	useTheme,
} from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import pluginUiFixture from "../fixtures/plugin-ui-fixture";
import pluginUiOtherFixture from "../fixtures/plugin-ui-other-fixture";
import { toolCallId } from "../support/identifiers";
import { flushTestRenderer } from "../support/opentui";

const pluginUiTestEnvironment = async (
	executionMode: ExecutionMode = "interactive",
	testRendererOptions: Readonly<{ kittyKeyboard?: boolean }> = {}
) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-plugin-ui-"));
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const sessionId = `plugin-ui-${crypto.randomUUID()}`;
	const runtime = await loadPlugins({
		bundledPlugins: [
			{ factory: pluginUiFixture, id: "plugin_ui_fixture" },
			{
				factory: pluginUiOtherFixture,
				id: "plugin_ui_other_fixture",
			},
		],
		cliPaths: [],
		config: {
			configStore: createConfigStore({ homeRoot: root }),
			cwd: workspace,
			homeRoot: root,
			workspace,
		},
		userDataDir: root,
	});
	let pluginUIHost: PluginUIHost | undefined;
	function CapturePluginUIHost() {
		pluginUIHost = usePluginUIHost();
		return null;
	}
	function ThemeProbe({ label }: Readonly<{ label: string }>) {
		const { colors, currentTheme } = useTheme();
		return <text>{`${label}:${currentTheme.name}:${colors.primary}`}</text>;
	}
	const setup = await testRender(
		<ThemeProvider themeName="opencode">
			<ToastProvider>
				<KeyboardLayerProvider>
					<DialogProvider>
						<PluginUIHostProvider>
							<CapturePluginUIHost />
							<text>Plugin UI host fixture</text>
							<ThemeProbe label="global" />
							<LocalStyleProvider colors={{ primary: "#123456" }}>
								<ThemeProbe label="local" />
							</LocalStyleProvider>
						</PluginUIHostProvider>
					</DialogProvider>
				</KeyboardLayerProvider>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 16, width: 64, ...testRendererOptions }
	);
	await flushTestRenderer(setup, 2);
	if (pluginUIHost === undefined) {
		throw new Error("Plugin UI host was not mounted.");
	}
	const unbindPluginUIHost = runtime.bindPluginUIHost(sessionId, pluginUIHost);
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
	const dispose = async (): Promise<void> => {
		await act(async () => {
			unbindPluginUIHost();
			await runtime.shutdown();
		});
		await act(() => setup.renderer.destroy());
		await fs.rm(root, { recursive: true, force: true });
	};
	return {
		dispose,
		executeCommand,
		pluginUIHost,
		runtime,
		pressEscape,
		unbindPluginUIHost,
		sessionId,
		setup,
		workspace,
	};
};

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
