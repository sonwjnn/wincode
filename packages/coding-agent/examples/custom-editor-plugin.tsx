import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
	PluginFactory,
	PluginUICustomComponent,
	PluginUICustomFactory,
} from "@wincode/coding-agent";
import { useRef } from "react";

const ReplyEditor: PluginUICustomComponent<string> = ({
	done,
	environment,
	height,
	keybindings,
	signal,
	theme,
	width,
}) => {
	const input = useRef<InputRenderable>(null);
	useKeyboard((key) => {
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			done(input.current?.value ?? "");
		}
	});

	return (
		<box flexDirection="column" gap={1} paddingX={1} width="100%">
			<text fg={theme.colors.text}>Reply to the current message</text>
			<text fg={theme.colors.textMuted} wrapMode="word">
				{`${environment.sessionId} · ${width}×${height} · Enter: ${keybindings.composer[0]?.action} · signal: ${signal.aborted ? "cancelled" : "active"}`}
			</text>
			<input
				focused
				onContentChange={() => undefined}
				placeholder="Write a reply"
				ref={input}
			/>
		</box>
	);
};

const replyEditorFactory: PluginUICustomFactory<string> = async () =>
	ReplyEditor;

const customEditorPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "custom_editor" });
	plugin.registerCommand({
		description: "Open a temporary editor for a reply.",
		name: "reply-editor",
		handler: async ({ ui }) => {
			const reply = await ui.custom(replyEditorFactory, {
				title: "Compose reply",
			});
			return reply === undefined ? "Reply editor dismissed." : reply;
		},
	});
};

export default customEditorPlugin;
