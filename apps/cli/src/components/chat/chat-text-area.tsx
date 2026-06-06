import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../providers/keyboard-layer/constants";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { CommandMenu } from "../command-menu";
import type { CommandSpec } from "../command-menu/commands";
import { useCommandExecutor } from "../command-menu/use-command-executor";
import { useCommandMenu } from "../command-menu/use-command-menu";
import { StatusBar } from "../status-bar";

type ChatTextAreaProps = {
	disabled?: boolean;
	onSubmit: (value: string) => void;
};

type CommandTextBuffer = Pick<TextareaRenderable, "plainText" | "setText">;

export const clearCommandText = (textarea: CommandTextBuffer | null) => {
	if (textarea?.plainText.startsWith("/")) {
		textarea.setText("");
	}
};

export function ChatTextArea({
	disabled = false,
	onSubmit,
}: ChatTextAreaProps) {
	const { mode, cycleMode } = usePromptConfig();
	const textAreaRef = useRef<TextareaRenderable>(null);
	const onSubmitRef = useRef<() => void>(() => {
		// default value
	});

	const { isTopLayer, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const {
		showCommandMenu,
		filteredCommands,
		selectedIndex,
		scrollRef,
		handleContentChange,
		resolveCommand,
		setSelectedIndex,
	} = useCommandMenu();
	const { executeCommand } = useCommandExecutor();

	const handleCommand = useCallback(
		(command: CommandSpec | undefined) => {
			const textarea = textAreaRef.current;
			if (!(textarea && command)) {
				return;
			}

			textarea.setText("");
			executeCommand(command);
		},
		[executeCommand]
	);

	const handleCommandExecute = useCallback(
		(index: number) => {
			const command = resolveCommand(index);
			handleCommand(command);
		},
		[resolveCommand, handleCommand]
	);

	const handleSubmit = useCallback(() => {
		if (disabled) {
			return;
		}

		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		const text = textarea.plainText.trim();
		if (text.length === 0) {
			return;
		}

		onSubmit(text);
		textarea.setText("");
	}, [disabled, onSubmit]);

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		handleContentChange(textarea.plainText);
		// syncMentionMenu(text, textarea.cursorOffset);
	}, [
		handleContentChange,
		// ,syncMentionMenu
	]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.onSubmit = () => {
			onSubmitRef.current();
		};
	}, []);

	onSubmitRef.current = () => {
		if (disabled) {
			return;
		}

		if (showCommandMenu) {
			const command = resolveCommand(selectedIndex);
			handleCommand(command);
			return;
		}

		// if (showMentionMenu) {
		//   const candidate = mentionCandidates[mentionSelectedIndex];
		//   if (candidate) {
		//     handleMentionExecute(mentionSelectedIndex);
		//     return;
		//   }
		// }

		handleSubmit();
	};

	useKeyboard((key) => {
		if (disabled) {
			return;
		}
		if (!isTopLayer("base")) {
			return;
		}
		if (key.name === "tab") {
			key.preventDefault();
			cycleMode();
		}
	});

	useEffect(() => {
		setResponder("base", () => {
			if (disabled) {
				return false;
			}

			const textarea = textAreaRef.current;
			if (textarea && textarea.plainText.length > 0) {
				textarea.setText("");
				return true;
			}
			return false;
		});

		return () => setResponder("base", null);
	}, [disabled, setResponder]);

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
				gap={1}
				width="100%"
			>
				<box
					backgroundColor={colors.surface}
					gap={1}
					justifyContent="center"
					paddingX={2}
					paddingY={1}
					position="relative"
					width="100%"
				>
					{showCommandMenu && (
						<box
							backgroundColor={colors.surface}
							bottom="100%"
							left={0}
							position="absolute"
							width="100%"
							zIndex={10}
						>
							<CommandMenu
								commands={filteredCommands}
								onExecute={handleCommandExecute}
								onSelect={setSelectedIndex}
								scrollRef={scrollRef}
								selectedIndex={selectedIndex}
							/>
						</box>
					)}

					<textarea
						focused={
							!disabled &&
							(isTopLayer("base") ||
								isTopLayer("command") ||
								isTopLayer("mention"))
						}
						keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
						onContentChange={handleTextareaContentChange}
						placeholder={`Ask anything... "Fix broken tests"`}
						ref={textAreaRef}
					/>
					<StatusBar />
				</box>
			</box>
		</box>
	);
}
