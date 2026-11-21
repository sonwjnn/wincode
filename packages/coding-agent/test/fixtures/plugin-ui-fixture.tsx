import type {
	PluginFactory,
	PluginUICustomBounds,
	PluginUICustomComponent,
	PluginUICustomContext,
	PluginUICustomFactory,
	PluginUICustomPresentationMode,
	PluginUIFooterComponent,
	PluginUIHeaderComponent,
} from "@wincode/coding-agent";
import { useKeyboard } from "@wincode/tui";
import type { InputRenderable } from "@wincode/tui/core";
import { useRef, useState } from "react";
import { z } from "zod";

const fixtureHeader: PluginUIHeaderComponent = ({ height, theme, width }) => (
	<text>{`Fixture header ${theme.name} ${width}x${height}`}</text>
);

const replacementHeader: PluginUIHeaderComponent = ({ theme }) => (
	<text>{`Replacement header ${theme.name}`}</text>
);

const fixtureFooter: PluginUIFooterComponent = ({
	branch,
	height,
	statuses,
	theme,
	width,
}) => (
	<text>{`Fixture footer ${theme.name} ${width}x${height} ${branch ?? "no branch"} ${statuses.map(({ value }) => value).join("|")}`}</text>
);

const createCustomUIFixture = () => {
	const customFactoryStarted = Promise.withResolvers<void>();
	const customFactoryResult =
		Promise.withResolvers<PluginUICustomComponent<string>>();
	const state = {
		asyncFactoryResult: customFactoryResult.promise,
		factoryCalls: 0,
		factoryStarted: customFactoryStarted.promise,
		lastComponentDimensions: undefined as
			| Readonly<{ height: number; width: number }>
			| undefined,
		lastContext: undefined as PluginUICustomContext<string> | undefined,
		lastFactoryBounds: undefined as PluginUICustomBounds | undefined,
		lastPresentationState: undefined as
			| Readonly<{
					bounds: PluginUICustomBounds;
					focused: boolean;
					hidden: boolean;
					presentation: PluginUICustomPresentationMode;
			  }>
			| undefined,
		resolveAsyncFactory: customFactoryResult.resolve,
		startAsyncFactory: customFactoryStarted.resolve,
		throwComponent: false,
	};
	const component: PluginUICustomComponent<string> = ({
		done,
		environment,
		height,
		keybindings,
		presentation,
		presentationHandle,
		theme,
		width,
	}) => {
		state.lastComponentDimensions = { height, width };
		state.lastPresentationState = {
			bounds: presentationHandle.getBounds(),
			focused: presentationHandle.isFocused(),
			hidden: presentationHandle.isHidden(),
			presentation,
		};
		if (state.throwComponent) {
			throw new Error("Fixture custom component failed.");
		}
		const input = useRef<InputRenderable>(null);
		useKeyboard((key) => {
			if (key.name === "escape" || (key.ctrl && key.name === "c")) {
				key.preventDefault();
				return;
			}
			if (!presentationHandle.isFocused()) {
				return;
			}
			if (key.name === "enter" || key.name === "return") {
				key.preventDefault();
				done(input.current?.value ?? "custom complete");
			}
		});
		return (
			<box flexDirection="column" width="100%">
				<text>Fixture custom UI</text>
				<text>
					{`${theme.name}:${width}x${height}:${keybindings.composer.length}:${environment.executionMode}`}
				</text>
				<input
					focused={presentationHandle.isFocused()}
					onContentChange={() => undefined}
					placeholder="Custom response"
					ref={input}
				/>
			</box>
		);
	};
	const factory = async (
		context: PluginUICustomContext<string>
	): Promise<PluginUICustomComponent<string>> => {
		state.factoryCalls += 1;
		state.lastContext = context;
		state.lastFactoryBounds = context.presentationHandle.getBounds();
		return component;
	};
	return { component, factory, state };
};

const errorCode = (error: unknown): string =>
	typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: "missing-code";

const createKeyboardFixture = () => {
	const state = {
		componentKeys: [] as string[],
		consumingInputs: [] as string[],
		inputEvents: [] as string[],
		localInputs: [] as string[],
		shortcutCalls: 0,
		shortcutContexts: [] as string[],
		shortcutThemeCount: 0,
		stopInput: undefined as (() => void) | undefined,
	};
	const component: PluginUICustomComponent<string> = ({ done }) => {
		const [localInputs, setLocalInputs] = useState<string[]>([]);
		useKeyboard((key) => {
			if (key.name === "escape" || (key.ctrl && key.name === "c")) {
				state.componentKeys.push(key.name);
				key.preventDefault();
				return;
			}
			if (key.ctrl && key.shift && key.name === "p") {
				key.preventDefault();
				state.localInputs.push("Ctrl+Shift+P");
				setLocalInputs((current) => [...current, "Ctrl+Shift+P"]);
				return;
			}
			if (key.name === "x") {
				key.preventDefault();
				state.localInputs.push("x");
				setLocalInputs((current) => [...current, "x"]);
				return;
			}
			if (key.name === "enter" || key.name === "return") {
				key.preventDefault();
				done("keyboard complete");
			}
		});
		return (
			<box flexDirection="column">
				<text>Keyboard fixture</text>
				<text>Enter selects · Escape dismisses · Ctrl+C reclaims</text>
				<text>{`Shortcut calls: ${state.shortcutCalls}`}</text>
				<text>{`Local: ${localInputs.join(", ")}`}</text>
			</box>
		);
	};
	const factory: PluginUICustomFactory<string> = () => component;
	return { factory, state };
};

const pluginUiFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_fixture" });
	const { factory: customFactory, state: customUIState } =
		createCustomUIFixture();
	const { factory: keyboardFactory, state: keyboardState } =
		createKeyboardFixture();
	const promptEvents: string[] = [];
	const nestedPromptResult = Promise.withResolvers<boolean>();
	const inputAbortController = new AbortController();
	plugin.registerResource("custom_ui_state", customUIState);
	plugin.registerResource("keyboard_state", keyboardState);
	plugin.registerResource("prompt_events", promptEvents);
	plugin.registerResource("nested_prompt_result", nestedPromptResult.promise);
	plugin.registerResource("input_abort", {
		abort: () => inputAbortController.abort(),
		controller: inputAbortController,
	});
	plugin.onSessionStart(({ ui }) => {
		promptEvents.push(`session:${typeof ui.input}`);
	});
	plugin.onSessionShutdown(({ ui }) => {
		promptEvents.push(`shutdown:${typeof ui.input}`);
	});
	plugin.onUIPromptStart(({ kind, title }) => {
		promptEvents.push(`start:${kind}:${title}`);
		if (title === "Observer failure") {
			throw new Error("A prompt observer must not block the dialog.");
		}
		if (title === "Observer does not block") {
			return Promise.withResolvers<void>().promise;
		}
	});
	plugin.onUIPromptEnd(({ kind, title }) => {
		promptEvents.push(`end:${kind}:${title}`);
	});
	api.registerShortcut("ctrl+shift+p", {
		description: "Show the keyboard fixture shortcut.",
		handler: ({ pluginId, sessionId, shortcut, ui }) => {
			keyboardState.shortcutCalls += 1;
			keyboardState.shortcutContexts.push(
				`${pluginId}:${sessionId}:${shortcut}`
			);
			keyboardState.shortcutThemeCount = ui.getAllThemes().length;
		},
	});
	plugin.registerCommand({
		description:
			"Subscribe to terminal input while a keyboard-only UI is open.",
		name: "keyboard",
		handler: async ({ ui }) => {
			const unsubscribe = ui.onTerminalInput((data) => {
				keyboardState.inputEvents.push(data);
				return data === "x" || data === "\u001b[120u"
					? { consume: true }
					: undefined;
			});
			try {
				return (
					(await ui.custom(keyboardFactory, {
						title: "Keyboard fixture",
					})) ?? "undefined"
				);
			} finally {
				unsubscribe();
			}
		},
	});
	plugin.registerCommand({
		description: "Try to consume every terminal input while the UI is open.",
		name: "keyboard-consume",
		handler: async ({ ui }) => {
			const unsubscribe = ui.onTerminalInput((data) => {
				keyboardState.consumingInputs.push(data);
				return { consume: true };
			});
			try {
				return (
					(await ui.custom(keyboardFactory, {
						title: "Keyboard fixture",
					})) ?? "undefined"
				);
			} finally {
				unsubscribe();
			}
		},
	});
	plugin.registerCommand({
		description:
			"Keep a raw input subscription until it is explicitly removed.",
		name: "listen-terminal-input",
		handler: ({ ui }) => {
			keyboardState.stopInput?.();
			keyboardState.stopInput = ui.onTerminalInput((data) => {
				keyboardState.inputEvents.push(data);
			});
			return "listening";
		},
	});
	plugin.registerCommand({
		description: "Remove the fixture raw input subscription.",
		name: "stop-terminal-input",
		handler: () => {
			keyboardState.stopInput?.();
			keyboardState.stopInput = undefined;
			return "stopped";
		},
	});
	plugin.registerCommand({
		description:
			"Call a no-op raw input subscription in a noninteractive mode.",
		name: "terminal-input-noop",
		handler: ({ ui }) => {
			keyboardState.stopInput = ui.onTerminalInput((data) => {
				keyboardState.inputEvents.push(data);
				return { consume: true };
			});
			return "terminal input disabled";
		},
	});
	plugin.registerTool({
		description: "Request custom React UI through host-mediated Plugin UI.",
		inputSchema: z.object({}),
		name: "ui_custom",
		handler: async (_input, { ui }) => ({
			output:
				(await ui.custom(customFactory, {
					title: "Fixture event custom UI",
				})) ?? "undefined",
			type: "success",
		}),
	});
	plugin.registerTool({
		description: "Request an overlay through host-mediated Plugin UI.",
		inputSchema: z.object({}),
		name: "ui_custom_overlay",
		handler: async (_input, { ui }) => ({
			output:
				(await ui.custom(customFactory, {
					presentation: "overlay",
					title: "Fixture event custom overlay",
				})) ?? "undefined",
			type: "success",
		}),
	});
	plugin.registerTool({
		description: "Request a full-screen custom UI through host mediation.",
		inputSchema: z.object({}),
		name: "ui_custom_full_screen",
		handler: async (_input, { ui }) => ({
			output:
				(await ui.custom(customFactory, {
					presentation: "full-screen",
					title: "Fixture event full-screen UI",
				})) ?? "undefined",
			type: "success",
		}),
	});
	plugin.registerTool({
		description: "Request input through host-mediated Plugin UI.",
		inputSchema: z.object({}),
		name: "ui_input",
		handler: async (_input, { ui }) => ({
			output: (await ui.input("Tool UI input")) ?? "undefined",
			type: "success",
		}),
	});
	plugin.registerTool({
		description: "Report progress while custom Plugin UI remains open.",
		inputSchema: z.object({}),
		name: "ui_progress",
		handler: async () => ({ output: "progress completed", type: "success" }),
	});
	plugin.registerCommand({
		description: "Select an option through host-mediated Plugin UI.",
		name: "select",
		handler: async ({ ui }) =>
			(await ui.select("Choose a fixture option", ["Alpha", "Beta"])) ??
			"dismissed",
	});
	plugin.registerCommand({
		description: "Confirm through host-mediated Plugin UI.",
		name: "confirm",
		handler: async ({ ui }) =>
			(await ui.confirm("Confirm fixture", "Proceed?"))
				? "confirmed"
				: "cancelled",
	});
	plugin.registerCommand({
		description: "Request text through host-mediated Plugin UI.",
		name: "input",
		handler: async ({ ui }) => (await ui.input("Fixture input")) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Edit text through host-mediated Plugin UI.",
		name: "editor",
		handler: async ({ ui }) =>
			(await ui.editor("Fixture editor", "Original text")) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Save new text through host-mediated Plugin UI.",
		name: "editor-save",
		handler: async ({ ui }) =>
			(await ui.editor("Fixture editor")) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Return the select timeout default.",
		name: "timeout-select",
		handler: async ({ ui }) =>
			String(await ui.select("Timed selection", ["Wait"], { timeout: 20 })),
	});
	plugin.registerCommand({
		description: "Return the confirm timeout default.",
		name: "timeout-confirm",
		handler: async ({ ui }) =>
			String(
				await ui.confirm("Timed confirmation", undefined, { timeout: 20 })
			),
	});
	plugin.registerCommand({
		description: "Open a confirmation whose deadline exceeds one timer.",
		name: "long-timeout-confirm",
		handler: async ({ ui }) =>
			String(
				await ui.confirm("Long timeout confirmation", undefined, {
					timeout: 2_147_483_648,
				})
			),
	});
	plugin.registerCommand({
		description: "Return the input timeout default.",
		name: "timeout-input",
		handler: async ({ ui }) =>
			String(await ui.input("Timed input", undefined, { timeout: 20 })),
	});
	plugin.registerCommand({
		description: "Return the editor timeout default.",
		name: "timeout-editor",
		handler: async ({ ui }) =>
			String(await ui.editor("Timed editor", "Draft", { timeout: 20 })),
	});
	plugin.registerCommand({
		description: "Request input that the fixture can abort.",
		name: "input-abort",
		handler: async ({ ui }) =>
			(await ui.input("Abortable input", undefined, {
				signal: inputAbortController.signal,
			})) ?? "undefined",
	});
	plugin.registerCommand({
		description:
			"Open a child dialog that times out without closing its parent.",
		name: "nested-timeout",
		handler: async ({ ui }) => {
			const parent = ui.input("Parent prompt");
			const child = await ui.confirm("Inner prompt", "This prompt times out.", {
				timeout: 250,
			});
			nestedPromptResult.resolve(child);
			return `${child}:${(await parent) ?? "undefined"}`;
		},
	});
	plugin.registerCommand({
		description: "Open overlapping prompts for lifecycle coalescing.",
		name: "overlapping-prompts",
		handler: async ({ ui }) => {
			const first = ui.select("First prompt", ["Continue"]);
			const second = ui.confirm("Second prompt");
			const [selection, confirmation] = await Promise.all([first, second]);
			return `${selection ?? "undefined"}:${confirmation}`;
		},
	});
	plugin.registerCommand({
		description: "Verify a failing prompt observer does not block the dialog.",
		name: "observer-failure",
		handler: async ({ ui }) =>
			(await ui.confirm("Observer failure")) ? "confirmed" : "cancelled",
	});
	plugin.registerCommand({
		description: "Verify a pending prompt observer does not block the dialog.",
		name: "observer-pending",
		handler: async ({ ui }) =>
			(await ui.confirm("Observer does not block")) ? "confirmed" : "cancelled",
	});
	plugin.registerCommand({
		description: "Send a nonblocking warning notification.",
		name: "notify",
		handler: ({ ui }) => {
			ui.notify("Fixture notification", "warning");
			return "notified";
		},
	});
	plugin.registerCommand({
		description: "Set namespaced Plugin UI status and widgets.",
		name: "ui-contributions",
		handler: ({ ui }) => {
			ui.setStatus("shared", "Fixture shared status");
			ui.setStatus("alpha", "Fixture alpha status");
			ui.setWidget("shared", ["Fixture shared widget"], {
				placement: "aboveEditor",
			});
			ui.setWidget("alpha", ["Fixture alpha widget"], {
				placement: "aboveEditor",
			});
			ui.setWidget("below", ["Fixture below widget"], {
				placement: "belowEditor",
			});
			return "contributions set";
		},
	});
	plugin.registerCommand({
		description: "Clear this Plugin's namespaced status and widgets.",
		name: "clear-ui-contributions",
		handler: ({ ui }) => {
			ui.setStatus("shared", undefined);
			ui.setStatus("alpha", undefined);
			ui.setWidget("shared", undefined);
			ui.setWidget("alpha", undefined);
			ui.setWidget("below", undefined);
			return "contributions cleared";
		},
	});
	plugin.registerCommand({
		description: "Own and replace the host Plugin UI header and footer.",
		name: "set-ui-chrome",
		handler: ({ ui }) =>
			JSON.stringify({
				header: ui.setHeader(fixtureHeader),
				footer: ui.setFooter(fixtureFooter),
			}),
	});
	plugin.registerCommand({
		description: "Replace this Plugin's owned header without stacking.",
		name: "replace-ui-header",
		handler: ({ ui }) => JSON.stringify(ui.setHeader(replacementHeader)),
	});
	plugin.registerCommand({
		description: "Release this Plugin's host header and footer ownership.",
		name: "clear-ui-chrome",
		handler: ({ ui }) =>
			JSON.stringify({
				header: ui.setHeader(undefined),
				footer: ui.setFooter(undefined),
			}),
	});
	plugin.registerCommand({
		description:
			"Set view-scoped presentation controls and the terminal title.",
		name: "set-presentation",
		handler: ({ ui }) => {
			ui.setWorkingMessage("Fixture working message");
			ui.setWorkingVisible(false);
			ui.setWorkingIndicator({ frames: ["A", "B"], intervalMs: 120 });
			ui.setTitle("Fixture terminal title");
			ui.setHiddenThinkingLabel("Fixture reasoning label");
			ui.setToolsExpanded(true);
			return String(ui.getToolsExpanded());
		},
	});
	plugin.registerCommand({
		description: "Reset this Plugin's active presentation controls.",
		name: "clear-presentation",
		handler: ({ ui }) => {
			ui.setWorkingMessage(undefined);
			ui.setWorkingIndicator(undefined);
			ui.setTitle(undefined);
			ui.setHiddenThinkingLabel(undefined);
			return String(ui.getToolsExpanded());
		},
	});
	plugin.registerCommand({
		description: "Read explicit terminal-free presentation defaults.",
		name: "presentation-defaults",
		handler: ({ ui }) => {
			ui.setStatus("ignored", "ignored");
			ui.setWidget("ignored", ["ignored"]);
			ui.setWorkingMessage("ignored");
			ui.setWorkingVisible(false);
			ui.setWorkingIndicator({ frames: ["ignored"] });
			ui.setTitle("ignored");
			ui.setHiddenThinkingLabel("ignored");
			ui.setToolsExpanded(true);
			return JSON.stringify({
				expanded: ui.getToolsExpanded(),
				footer: ui.setFooter(fixtureFooter),
				header: ui.setHeader(fixtureHeader),
			});
		},
	});
	plugin.registerCommand({
		description: "Open a custom React editor directly from a user command.",

		name: "custom",
		handler: async ({ ui }) =>
			(await ui.custom(customFactory, { title: "Fixture custom editor" })) ??
			"undefined",
	});
	plugin.registerCommand({
		description: "Open a custom React overlay directly from a user command.",
		name: "custom-overlay",
		handler: async ({ ui }) =>
			(await ui.custom(customFactory, {
				presentation: "overlay",
				title: "Fixture custom overlay",
			})) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Open a positioned custom React overlay from a user command.",
		name: "custom-overlay-positioned",
		handler: async ({ ui }) =>
			(await ui.custom(customFactory, {
				anchor: "top-right",
				margin: 1,
				maxHeight: 6,
				presentation: "overlay",
				title: "Fixture positioned custom overlay",
				width: "50%",
			})) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Reject invalid custom overlay options before admission.",
		name: "custom-overlay-invalid",
		handler: async ({ ui }) => {
			const failures: string[] = [];
			for (const options of [
				{ presentation: "overlay", width: 0 },
				{ presentation: "editor", width: 10 },
				{ presentation: "full-screen", margin: 1 },
			] as const) {
				try {
					await ui.custom(customFactory, options);
					failures.push("unexpected-success");
				} catch (error) {
					failures.push(errorCode(error));
				}
			}
			return failures.join(",");
		},
	});
	plugin.registerCommand({
		description: "Open full-screen custom React UI from a user command.",
		name: "custom-full-screen",
		handler: async ({ ui }) =>
			(await ui.custom(customFactory, {
				presentation: "full-screen",
				title: "Fixture full-screen custom UI",
			})) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Return the stable busy error for a competing custom UI.",
		name: "custom-busy",
		handler: async ({ ui }) => {
			try {
				await ui.custom(customFactory);
				return "unexpected-success";
			} catch (error) {
				return errorCode(error);
			}
		},
	});
	plugin.registerCommand({
		description: "Return the stable error for a failing custom component.",
		name: "custom-component-failure",
		handler: async ({ ui }) => {
			customUIState.throwComponent = true;
			try {
				await ui.custom(customFactory);
				return "unexpected-success";
			} catch (error) {
				return errorCode(error);
			}
		},
	});
	plugin.registerCommand({
		description: "Return the stable error for a failing full-screen component.",
		name: "custom-full-screen-component-failure",
		handler: async ({ ui }) => {
			customUIState.throwComponent = true;
			try {
				await ui.custom(customFactory, { presentation: "full-screen" });
				return "unexpected-success";
			} catch (error) {
				return errorCode(error);
			}
		},
	});
	plugin.registerCommand({
		description: "Return the stable error for a failing custom factory.",
		name: "custom-factory-failure",
		handler: async ({ ui }) => {
			try {
				await ui.custom(async () => {
					throw new Error("Fixture custom factory failed.");
				});
				return "unexpected-success";
			} catch (error) {
				return errorCode(error);
			}
		},
	});
	plugin.registerCommand({
		description:
			"Open a custom UI whose asynchronous factory can resolve late.",
		name: "custom-late-factory",
		handler: async ({ ui }) =>
			(await ui.custom((context) => {
				customUIState.factoryCalls += 1;
				customUIState.lastContext = context;
				customUIState.startAsyncFactory();
				return customUIState.asyncFactoryResult;
			})) ?? "undefined",
	});
	plugin.registerCommand({
		description: "Read and change the shared theme.",
		name: "theme",
		handler: ({ ui }) => {
			const listed = ui.getAllThemes();
			const loaded = ui.getTheme("one-dark");
			const changed = ui.setTheme("one-dark");
			const invalid = ui.setTheme("missing-theme");
			const unclonableTheme =
				loaded === undefined ? undefined : { ...loaded, copy: () => undefined };
			const invalidClone =
				unclonableTheme === undefined
					? undefined
					: ui.setTheme(unclonableTheme);
			return JSON.stringify({
				count: listed.length,
				loaded: loaded?.name,
				changed,
				invalid,
				invalidClone,
			});
		},
	});
};

export default pluginUiFixture;
