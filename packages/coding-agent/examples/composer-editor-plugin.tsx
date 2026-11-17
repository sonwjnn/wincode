import type {
	PluginAutocompleteProviderFactory,
	PluginEditorComponent,
	PluginFactory,
} from "@wincode/coding-agent";

const GREETING = "Thanks for the update.";

const ComposerEditor: PluginEditorComponent = ({ defaultEditor, theme }) => (
	<box flexDirection="column" gap={1}>
		<text fg={theme.colors.textMuted}>
			Type ! at the cursor to insert a suggested reply.
		</text>
		{defaultEditor}
	</box>
);

const greetingAutocomplete: PluginAutocompleteProviderFactory = (current) => ({
	...current,
	getSuggestions(context) {
		if (!context.text.slice(0, context.cursorOffset).endsWith("!")) {
			return current.getSuggestions(context);
		}
		return {
			items: [
				{
					description: "Insert a polite acknowledgment.",
					label: "Thank the sender",
					value: GREETING,
				},
			],
			prefix: "!",
		};
	},
	applyCompletion(context, item, prefix) {
		if (item.value !== GREETING) {
			return current.applyCompletion(context, item, prefix);
		}
		const start = Math.max(0, context.cursorOffset - prefix.length);
		return {
			cursorOffset: start + item.value.length,
			text: `${context.text.slice(0, start)}${item.value}${context.text.slice(context.cursorOffset)}`,
		};
	},
});

const composerEditorPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "composer_editor" });
	plugin.onSessionStart(({ ui }) => {
		const result = ui.setEditorComponent(ComposerEditor);
		if (result?.success === false) {
			ui.notify(
				`The composer editor is owned by Plugin '${result.ownerPluginId}'.`,
				"warning"
			);
			return;
		}
		ui.addAutocompleteProvider(greetingAutocomplete);
	});
};

export default composerEditorPlugin;
