import type {
	PluginFactory,
	PluginUICustomComponent,
	PluginUICustomFactory,
} from "@wincode/coding-agent";
import { InlineNotice, useKeyboard } from "@wincode/tui";
import type { InputRenderable } from "@wincode/tui/core";
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
			<InlineNotice>Reply to the current message</InlineNotice>
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

const replyCommands = [
	{ name: "reply-editor", presentation: undefined },
	{ name: "reply-overlay", presentation: "overlay" },
	{ name: "reply-full-screen", presentation: "full-screen" },
] as const;

const customEditorPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "custom_editor" });
	for (const { name, presentation } of replyCommands) {
		plugin.registerCommand({
			description: `Open a temporary ${presentation ?? "editor"} for a reply.`,
			name,
			handler: async ({ ui }) => {
				const options =
					presentation === undefined
						? { title: "Compose reply" }
						: { presentation, title: "Compose reply" };
				const reply = await ui.custom(replyEditorFactory, options);
				return reply === undefined ? "Reply editor dismissed." : reply;
			},
		});
	}
};

export default customEditorPlugin;
