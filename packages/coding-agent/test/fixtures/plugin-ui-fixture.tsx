import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
	PluginFactory,
	PluginUICustomComponent,
	PluginUICustomContext,
} from "@wincode/coding-agent";
import { useRef } from "react";
import { z } from "zod";

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
		resolveAsyncFactory: customFactoryResult.resolve,
		startAsyncFactory: customFactoryStarted.resolve,
		throwComponent: false,
	};
	const component: PluginUICustomComponent<string> = ({
		done,
		environment,
		height,
		keybindings,
		theme,
		width,
	}) => {
		state.lastComponentDimensions = { height, width };
		if (state.throwComponent) {
			throw new Error("Fixture custom component failed.");
		}
		const input = useRef<InputRenderable>(null);
		useKeyboard((key) => {
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
					focused
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
		return component;
	};
	return { component, factory, state };
};

const errorCode = (error: unknown): string =>
	typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: "missing-code";

const pluginUiFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_fixture" });
	const { factory: customFactory, state: customUIState } =
		createCustomUIFixture();
	const promptEvents: string[] = [];
	const nestedPromptResult = Promise.withResolvers<boolean>();
	const inputAbortController = new AbortController();
	plugin.registerResource("custom_ui_state", customUIState);
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
		description: "Open a custom React editor directly from a user command.",
		name: "custom",
		handler: async ({ ui }) =>
			(await ui.custom(customFactory, { title: "Fixture custom editor" })) ??
			"undefined",
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
