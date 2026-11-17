import type { PluginFactory } from "@wincode/coding-agent";
import { z } from "zod";

const pluginUiFixture: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "plugin_ui_fixture" });
	const promptEvents: string[] = [];
	const nestedPromptResult = Promise.withResolvers<boolean>();
	const inputAbortController = new AbortController();
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
		description: "Request input through host-mediated Plugin UI.",
		inputSchema: z.object({}),
		name: "ui_input",
		handler: async (_input, { ui }) => ({
			output: (await ui.input("Tool UI input")) ?? "undefined",
			type: "success",
		}),
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
