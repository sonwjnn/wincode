import type { TextareaOptions, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { StatusBar } from "../status-bar";

const CHAT_TEXT_AREA_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> =
	[
		{ name: "return", action: "submit" },
		{ name: "enter", action: "submit" },
		{ name: "return", shift: true, action: "newline" },
		{ name: "enter", shift: true, action: "newline" },
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
	disabled?: boolean;
	onSubmit: (value: string) => void;
};

type SubmitChatTextAreaValueOptions = {
	disabled: boolean;
	onSubmit: (value: string) => void;
	textArea: Pick<TextareaRenderable, "clear" | "plainText"> | null;
};

export const submitChatTextAreaValue = ({
	disabled,
	onSubmit,
	textArea,
}: SubmitChatTextAreaValueOptions) => {
	if (disabled) {
		return;
	}

	const value = textArea?.plainText.trim() ?? "";

	if (!value) {
		return;
	}

	onSubmit(value);
	textArea?.clear();
};

export function ChatTextArea({
	focused = true,
	disabled = false,
	onSubmit,
}: ChatTextAreaProps) {
	const { colors } = useTheme();
	const { cycleMode, mode } = usePromptConfig();
	const textAreaRef = useRef<TextareaRenderable>(null);

	useKeyboard((key) => {
		if (key.name !== "tab" || key.repeated || disabled) {
			return;
		}

		cycleMode();
	});

	const handleSubmit = () => {
		submitChatTextAreaValue({
			disabled,
			onSubmit,
			textArea: textAreaRef.current,
		});
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
						keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
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
