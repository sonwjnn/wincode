import type { TextareaOptions, TextareaRenderable } from "@opentui/core";
import { useRef } from "react";

const CHAT_TEXT_AREA_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> =
	[
		{ name: "return", action: "newline", shift: true },
		{ name: "linefeed", action: "newline", shift: true },
		{ name: "return", action: "submit" },
		{ name: "linefeed", action: "submit" },
		{ name: "enter", action: "submit" },
		{ name: "kpenter", action: "submit" },
	];

const TERMINAL_GUTTER_WIDTH = 8;
const MIN_TEXT_AREA_WIDTH = 5;

export const getChatTextAreaWidth = (terminalWidth: number, maxWidth: number) =>
	Math.max(
		MIN_TEXT_AREA_WIDTH,
		Math.min(terminalWidth - TERMINAL_GUTTER_WIDTH, maxWidth)
	);

type ChatTextAreaProps = {
	focused?: boolean;
	height: number;
	onSubmit: (value: string) => void;
	placeholder: string;
	resetKey?: number;
};

export function ChatTextArea({
	focused = true,
	height,
	onSubmit,
	placeholder,
	resetKey,
}: ChatTextAreaProps) {
	const textAreaRef = useRef<TextareaRenderable>(null);

	const handleSubmit = () => {
		onSubmit(textAreaRef.current?.plainText.trim() ?? "");
	};

	return (
		<box border borderStyle="rounded" flexDirection="column" paddingX={1}>
			<textarea
				focused={focused}
				height={height}
				key={resetKey}
				keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
				onSubmit={handleSubmit}
				placeholder={placeholder}
				ref={textAreaRef}
				wrapMode="word"
			/>
		</box>
	);
}
