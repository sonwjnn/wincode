import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { findFileMentionRanges } from "../../lib/mention-grammar";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../providers/keyboard-layer/constants";
import { usePromptConfig } from "../../providers/prompt-config";
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { CommandMenu } from "../command-menu";
import { useCommandExecutor } from "../command-menu/use-command-executor";
import { FileMentionMenu } from "../file-mention-menu";
import { StatusBar } from "../status-bar";
import { getFileMentionOptions } from "./input-controller/file-mention-options";
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
	const commandEscapeRef = useRef<() => void>(() => undefined);
	const ctrlCRef = useRef<() => boolean>(() => false);
	const lastTextSyncRevisionRef = useRef(0);
	const onSubmitRef = useRef<() => void>(() => undefined);

	const { isTopLayer, pop, push, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const { executeCommand } = useCommandExecutor();
	const mentionSyntaxStyle = useMemo(
		() =>
			SyntaxStyle.fromStyles({
				fileMention: { bold: true, fg: colors.primary },
			}),
		[colors.primary]
	);

	const { actions, state } = useChatInputController({
		disabled,
		executeCommand,
		getFileMentionOptions,
		onSubmit,
		onTab: cycleMode,
	});

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		actions.onTextChange(textarea.plainText, textarea.cursorOffset);
	}, [actions]);

	useEffect(() => {
		if (lastTextSyncRevisionRef.current === state.textSyncRevision) {
			return;
		}

		lastTextSyncRevisionRef.current = state.textSyncRevision;

		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.setText(state.text);

		if (state.cursorOffset !== null) {
			textarea.cursorOffset = state.cursorOffset;
		}
	}, [state.cursorOffset, state.text, state.textSyncRevision]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.syntaxStyle = mentionSyntaxStyle;
		textarea.clearAllHighlights();

		const styleId = mentionSyntaxStyle.getStyleId("fileMention");
		if (styleId === null) {
			return;
		}

		for (const range of findFileMentionRanges(state.text)) {
			textarea.addHighlightByCharRange({
				end: range.end,
				hlRef: range.start,
				priority: 10,
				start: range.start,
				styleId,
			});
		}
	}, [mentionSyntaxStyle, state.text]);

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
		if (state.overlay.kind === null) {
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

	useKeyboard((key) => {
		if (disabled) {
			return;
		}

		if (state.overlay.kind !== null && isTopLayer("command")) {
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
								selectedIndex={state.overlay.selectedIndex}
								visibleStartIndex={state.visibleStartIndex}
							/>
						</box>
					)}

					{state.overlay.kind === "file-mention" && (
						<box
							backgroundColor={colors.surface}
							bottom="100%"
							left={0}
							position="absolute"
							width="100%"
							zIndex={10}
						>
							<FileMentionMenu
								items={state.overlay.items}
								onExecute={actions.onItemExecute}
								onSelect={actions.onItemSelect}
								selectedIndex={state.overlay.selectedIndex}
								visibleStartIndex={state.visibleStartIndex}
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
