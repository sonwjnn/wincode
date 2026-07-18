import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCommandExecutor } from "@/app/commands/use-app-command-executor";
import { CommandMenu } from "@/modules/commands/ui/command-menu";
import {
	deleteFileMentionAfterTrailingCharacterDelete,
	FileMentionMenu,
	findFileMentionRanges,
	getFileMentionOptions,
} from "@/modules/file-mentions";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { StatusBar } from "@/modules/prompt-settings/ui/prompt-status-bar";
import { EmptyBorder } from "@/shared/constants";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useChatInputController } from "../../hooks/input-controller/use-chat-input-controller";

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
	const currentTextRef = useRef("");
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

		const mentionDelete =
			state.overlay.kind === null
				? deleteFileMentionAfterTrailingCharacterDelete(
						currentTextRef.current,
						textarea.plainText,
						textarea.cursorOffset
					)
				: null;
		if (mentionDelete) {
			textarea.setText(mentionDelete.text);
			textarea.cursorOffset = mentionDelete.cursorOffset;
			actions.onTextChange(mentionDelete.text, mentionDelete.cursorOffset);
			return;
		}

		actions.onTextChange(textarea.plainText, textarea.cursorOffset);
	}, [actions, state.overlay.kind]);

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
	currentTextRef.current = state.text;
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
		<box
			alignItems="center"
			overflow="visible"
			position="relative"
			width="100%"
		>
			{state.overlay.kind === "command" && (
				<box
					border={["left", "right"]}
					borderColor={colors.suggestionBorder}
					bottom="100%"
					customBorderChars={{
						...EmptyBorder,
						vertical: "┃",
					}}
					left={0}
					position="absolute"
					right={0}
					zIndex={10}
				>
					<box backgroundColor={colors.surface} width="100%">
						<CommandMenu
							commands={state.overlay.items}
							onExecute={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
							visibleStartIndex={state.visibleStartIndex}
						/>
					</box>
				</box>
			)}

			{state.overlay.kind === "file-mention" && (
				<box
					border={["left", "right"]}
					borderColor={colors.suggestionBorder}
					bottom="100%"
					customBorderChars={{
						...EmptyBorder,
						vertical: "┃",
					}}
					left={0}
					position="absolute"
					right={0}
					zIndex={10}
				>
					<box backgroundColor={colors.surface} width="100%">
						<FileMentionMenu
							items={state.overlay.items}
							onExecute={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
							visibleStartIndex={state.visibleStartIndex}
						/>
					</box>
				</box>
			)}

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
					width="100%"
				>
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
