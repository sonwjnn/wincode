import { expect, test } from "bun:test";
import type {
	PluginAutocompleteProvider,
	PluginAutocompleteProviderFactory,
} from "@wincode/coding-agent";
import {
	createPluginAutocompleteContext,
	wrapPluginAutocompleteProviders,
} from "@/modules/plugins/ui/plugin-autocomplete";

const providerFor =
	(label: string): PluginAutocompleteProviderFactory =>
	(current) => ({
		...current,
		getSuggestions: async (context) => {
			const previous = await current.getSuggestions(context);
			return {
				items: [{ label, value: label }, ...(previous?.items ?? [])],
				prefix: previous?.prefix ?? "#",
			};
		},
	});

const emptyProvider: PluginAutocompleteProvider = {
	getSuggestions: () => null,
	applyCompletion: (context, item, prefix) => {
		const start = context.cursorOffset - prefix.length;
		const text = `${context.text.slice(0, start)}${item.value}${context.text.slice(context.cursorOffset)}`;
		return { cursorOffset: start + item.value.length, text };
	},
};

test("Plugin autocomplete wrappers compose in registration order with the base provider", async () => {
	const context = createPluginAutocompleteContext("ship #", 6, "session-a");
	const provider = wrapPluginAutocompleteProviders(emptyProvider, [
		providerFor("first"),
		providerFor("second"),
	]);

	expect(await provider.getSuggestions(context)).toEqual({
		items: [
			{ label: "first", value: "first" },
			{ label: "second", value: "second" },
		],
		prefix: "#",
	});
	expect(context).toEqual({
		column: 6,
		cursorOffset: 6,
		line: 0,
		lines: ["ship #"],
		sessionId: "session-a",
		text: "ship #",
	});
});
