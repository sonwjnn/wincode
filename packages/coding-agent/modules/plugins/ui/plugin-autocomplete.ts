import type {
	PluginAutocompleteContext,
	PluginAutocompleteProvider,
	PluginAutocompleteProviderFactory,
} from "../public";

export const createPluginAutocompleteContext = (
	text: string,
	cursorOffset: number,
	sessionId: string
): PluginAutocompleteContext => {
	const boundedCursor = Math.max(0, Math.min(cursorOffset, text.length));
	const beforeCursor = text.slice(0, boundedCursor);
	const lines = text.split("\n");
	const line = beforeCursor.split("\n").length - 1;
	const column = beforeCursor.length - beforeCursor.lastIndexOf("\n") - 1;
	return Object.freeze({
		column,
		cursorOffset: boundedCursor,
		line,
		lines: Object.freeze(lines),
		sessionId,
		text,
	});
};

export const wrapPluginAutocompleteProviders = (
	base: PluginAutocompleteProvider,
	providers: readonly PluginAutocompleteProviderFactory[]
): PluginAutocompleteProvider =>
	[...providers].toReversed().reduce((current, wrap) => wrap(current), base);
