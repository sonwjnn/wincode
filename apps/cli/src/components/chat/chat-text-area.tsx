import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../providers/keyboard-layer/constants";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { CommandMenu } from "../command-menu";
import { useCommandExecutor } from "../command-menu/use-command-executor";
import { StatusBar } from "../status-bar";
import { useChatInputController } from "./input-controller/use-chat-input-controller";

type ChatTextAreaProps = {
	disabled?: boolean;
	onSubmit: (value: string) => void;
};

export function ChatTextArea({
	disabled = false,
	onSubmit,
}: ChatTextAreaProps) {
	const { mode, cycleMode } = usePromptConfig();
	const textAreaRef = useRef<TextareaRenderable>(null);
	const commandScrollRef = useRef<ScrollBoxRenderable>(null);
	const commandEscapeRef = useRef<() => void>(() => {
		// default value
	});
	const ctrlCRef = useRef<() => boolean>(() => false);
	const onSubmitRef = useRef<() => void>(() => {
		// default value
	});

	const { isTopLayer, pop, push, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const { executeCommand } = useCommandExecutor();

	const { actions, state } = useChatInputController({
		disabled,
		executeCommand,
		onSubmit,
		onTab: cycleMode,
	});

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		actions.onTextChange(textarea.plainText, textarea.cursorOffset);
		commandScrollRef.current?.scrollTo(0);
	}, [actions]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea || textarea.plainText === state.text) {
			return;
		}

		textarea.setText(state.text);
	}, [state.text]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.onSubmit = () => {
			onSubmitRef.current();
		};
	}, []);

	onSubmitRef.current = actions.onEnter;
	commandEscapeRef.current = actions.onEscape;
	ctrlCRef.current = actions.onCtrlC;

	useEffect(() => {
		if (state.overlay.kind !== "command") {
			return;
		}

		push("command", () => {
			commandEscapeRef.current();
			return true;
		});

		return () => pop("command");
	}, [pop, push, state.overlay.kind]);

	useEffect(() => {
		setResponder("base", () => ctrlCRef.current());

		return () => setResponder("base", null);
	}, [setResponder]);

	useEffect(() => {
		if (state.overlay.kind !== "command") {
			return;
		}

		const scrollbox = commandScrollRef.current;
		if (!scrollbox) {
			return;
		}

		const { selectedIndex } = state.overlay;
		if (selectedIndex < scrollbox.scrollTop) {
			scrollbox.scrollTo(selectedIndex);
			return;
		}

		const visibleEnd = scrollbox.scrollTop + scrollbox.viewport.height - 1;
		if (selectedIndex > visibleEnd) {
			scrollbox.scrollTo(selectedIndex - scrollbox.viewport.height + 1);
		}
	}, [state.overlay]);

	useKeyboard((key) => {
		if (disabled) {
			return;
		}

		if (state.overlay.kind === "command" && isTopLayer("command")) {
			if (key.name === "escape") {
				key.preventDefault();
				actions.onEscape();
				return;
			}

			if (key.name === "up") {
				key.preventDefault();
				actions.onArrowUp();
				return;
			}

			if (key.name === "down") {
				key.preventDefault();
				actions.onArrowDown();
				return;
			}
		}

		if (!isTopLayer("base")) {
			return;
		}

		if (key.name === "tab") {
			key.preventDefault();
			actions.onTab();
		}
	});

	const isFocused = !disabled && (isTopLayer("base") || isTopLayer("command"));

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
					{state.overlay.kind === "command" && (
						<box
							backgroundColor={colors.surface}
							bottom="100%"
							left={0}
							position="absolute"
							width="100%"
							zIndex={10}
						>
							<CommandMenu
								commands={state.overlay.items}
								onExecute={actions.onItemExecute}
								onSelect={actions.onItemSelect}
								scrollRef={commandScrollRef}
								selectedIndex={state.overlay.selectedIndex}
							/>
						</box>
					)}

					<textarea
						focused={isFocused}
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
