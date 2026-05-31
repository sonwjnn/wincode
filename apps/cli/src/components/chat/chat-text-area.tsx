import type { TextareaRenderable } from "@opentui/core";
import { useRef, useState } from "react";
import { useChatCommands } from "../../hooks/use-chat-commands";
import {
	CHAT_TEXT_AREA_KEY_BINDINGS,
	CHAT_TEXT_AREA_MIN_HEIGHT,
	getInputHeight,
	useInputKeyboard,
} from "../../hooks/use-input-keyboard";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { StatusBar } from "../status-bar";

const TERMINAL_GUTTER_WIDTH = 8;
const MIN_TEXT_AREA_WIDTH = 5;

export const getChatTextAreaWidth = (terminalWidth: number, maxWidth: number) =>
	Math.max(
		MIN_TEXT_AREA_WIDTH,
		Math.min(terminalWidth - TERMINAL_GUTTER_WIDTH, maxWidth)
	);

type ChatTextAreaProps = {
	focused?: boolean;
	disabled?: boolean;
	onSubmit: (value: string) => void;
};

type SubmitChatTextAreaValueOptions = {
	disabled: boolean;
	onCommand?: (value: string) => boolean;
	onSubmit: (value: string) => void;
	textArea: Pick<TextareaRenderable, "clear" | "plainText"> | null;
};

export type SubmitChatTextAreaValueResult =
	| "command"
	| "disabled"
	| "empty"
	| "submitted";

export const submitChatTextAreaValue = ({
	disabled,
	onCommand,
	onSubmit,
	textArea,
}: SubmitChatTextAreaValueOptions) => {
	if (disabled) {
		return "disabled";
	}

	const rawValue = textArea?.plainText ?? "";

	if (onCommand?.(rawValue)) {
		textArea?.clear();
		return "command";
	}

	const value = rawValue.trim();

	if (!value) {
		return "empty";
	}

	onSubmit(value);
	textArea?.clear();
	return "submitted";
};

export function ChatTextArea({
	focused = true,
	disabled = false,
	onSubmit,
}: ChatTextAreaProps) {
	const { runCommand } = useChatCommands();
	const { colors } = useTheme();
	const { cycleMode, mode } = usePromptConfig();
	const textAreaRef = useRef<TextareaRenderable>(null);
	const [textAreaHeight, setTextAreaHeight] = useState(
		CHAT_TEXT_AREA_MIN_HEIGHT
	);

	const resetTextAreaHeight = () => {
		setTextAreaHeight(CHAT_TEXT_AREA_MIN_HEIGHT);
	};

	useInputKeyboard({
		disabled,
		onClear: resetTextAreaHeight,
		onCycleMode: cycleMode,
		textAreaRef,
	});

	const handleContentChange = () => {
		setTextAreaHeight(getInputHeight(textAreaRef.current?.plainText ?? ""));
	};

	const handleSubmit = () => {
		const result = submitChatTextAreaValue({
			disabled,
			onCommand: runCommand,
			onSubmit,
			textArea: textAreaRef.current,
		});

		if (result === "command" || result === "submitted") {
			resetTextAreaHeight();
		}
	};

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={colors.mode[mode]}
				customBorderChars={{
					...EmptyBorder,
					vertical: "┃",
					bottomLeft: "╹",
				}}
				width="100%"
			>
				<box
					backgroundColor={colors.surface}
					gap={1}
					justifyContent="center"
					paddingBottom={1}
					paddingTop={1}
					paddingX={2}
					position="relative"
					width="100%"
				>
					<textarea
						focused={focused}
						height={textAreaHeight}
						keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
						onContentChange={handleContentChange}
						onSubmit={handleSubmit}
						placeholder={`Ask anything... "Fix broken tests"`}
						ref={textAreaRef}
					/>
					<StatusBar />
				</box>
			</box>
		</box>
	);
}
