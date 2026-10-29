import * as fs from "node:fs/promises";
import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ThinkingSelection } from "@wincode/ai";
import { isNull } from "@wincode/utils";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { CommandSuggestion } from "@/modules/commands/command-controller";
import { useCommandControllerFactory } from "@/modules/commands/command-controller-context";
import type { CommandCapability } from "@/modules/commands/commands";
import {
	deleteFileMentionAfterTrailingCharacterDelete,
	type FileMentionOption,
	findFileMentionRanges,
	getFileMentionOptions,
} from "@/modules/file-mentions";
import { StatusBar } from "@/modules/prompt-settings/ui/prompt-status-bar";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	registerClipboardTextTransform,
	useClipboard,
} from "@/shared/clipboard";
import { RoundedBorderChars } from "@/shared/constants";
import { useLatest } from "@/shared/hooks/use-latest";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getThinkingLevelBorderColor } from "@/shared/providers/theme/themes";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { SelectableList } from "@/shared/ui/selectable-list";
import {
	areFileMentionExtmarksCurrent,
	normalizeFileTokensForTrimmedText,
} from "../../attachments";
import { readClipboardImage, readImagePath } from "../../clipboard-image";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import { useChatInputController } from "../../hooks/input-controller/use-chat-input-controller";
import { expandPastedText, expandPastedTextInRange } from "../../pasted-text";
import type { ChatPromptComposition, ChatPromptSubmission } from "../../utils";
import {
	attachComposerDocumentToTextarea,
	createComposerDocument,
} from "../composer-document";
import { createPasteIntake } from "../paste-intake";
import { useComposerProviderSelection } from "../use-composer-provider-selection";
import { useSyntaxStyle } from "../use-syntax-style";

const EMPTY_PROMPT_HISTORY: PromptHistoryEntry[] = [];
const EMPTY_RECALLED_SUBMISSIONS: readonly ChatPromptComposition[] = [];
const EMPTY_COMMAND_CAPABILITIES: readonly CommandCapability[] = [];
const toSelectableCommandItem = (item: CommandSuggestion) => ({
	description: item.description,
	id: item.id,
	label: item.label,
});

const toSelectableFileMentionItem = (item: FileMentionOption) => ({
	id: item.path,
	label: item.label,
});

type ChatTextAreaProps = {
	id: string;
	sessionId?: string;
	disabled?: boolean;
	activityIndicator?: ReactNode;
	composerBorderColor?: string;
	draftKey?: string;
	unavailableCommandCapabilities?: readonly CommandCapability[];
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onProviderModelChanged?: () => void;
	onOpenSettings?: (section?: string) => Promise<void> | void;
	onEmptySubmit?: () => void | Promise<void>;
	providerController?: InteractiveProviderController;
	isSelectionReady?: boolean;
	statusBarThinkingSelection?: ThinkingSelection;
	/** Compositions a Recall returned, oldest first, waiting to enter the composer. */
	recalledSubmissions?: readonly ChatPromptComposition[];
	/** Changes whenever `recalledSubmissions` holds something new to restore. */
	recallRevision?: number;
	sessionPromptHistory?: PromptHistoryEntry[];
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
};

function ComposerTopBorder({
	activityIndicator,
	borderColor,
	statusBar,
}: {
	activityIndicator?: ReactNode;
	borderColor: string;
	statusBar?: ReactNode;
}) {
	const hasActivityIndicator = activityIndicator !== undefined;
	const hasStatusBar = statusBar !== undefined;
	return (
		<box alignItems="center" flexDirection="row" height={1} width="100%">
			<box
				border={["top", "left"]}
				borderColor={borderColor}
				customBorderChars={RoundedBorderChars}
				flexShrink={0}
				width={hasActivityIndicator ? 2 : 1}
			/>
			{hasActivityIndicator ? (
				<box flexShrink={0} paddingX={1}>
					{activityIndicator}
				</box>
			) : null}
			<box
				border={["top"]}
				borderColor={borderColor}
				customBorderChars={RoundedBorderChars}
				flexGrow={1}
				minWidth={0}
			/>
			{hasStatusBar ? (
				<box flexShrink={0} paddingX={1}>
					{statusBar}
				</box>
			) : null}
			<box
				border={["top", "right"]}
				borderColor={borderColor}
				customBorderChars={RoundedBorderChars}
				flexShrink={0}
				width={2}
			/>
		</box>
	);
}

export function ChatTextArea({
	id,
	sessionId,
	disabled = false,
	activityIndicator,
	composerBorderColor,
	draftKey,
	unavailableCommandCapabilities:
		viewUnavailableCapabilities = EMPTY_COMMAND_CAPABILITIES,
	onCompact,
	onProviderModelChanged,
	onOpenSettings,
	onSubmit,
	onEmptySubmit,
	providerController,
	isSelectionReady = true,
	statusBarThinkingSelection,
	recalledSubmissions = EMPTY_RECALLED_SUBMISSIONS,
	recallRevision = 0,
	sessionPromptHistory = EMPTY_PROMPT_HISTORY,
}: ChatTextAreaProps) {
	const {
		cycleThinkingLevel,
		hasThinkingLevels,
		isProviderStatusReady,
		selectedProviderModel,
		setFutureProviderModelSelection,
		thinkingLevel,
		unavailableCommandCapabilities,
	} = useComposerProviderSelection({
		disabled,
		isSelectionReady,
		onCompact,
		onProviderModelChanged,
		providerController,
		sessionId,
		statusBarThinkingSelection,
		unavailableCommandCapabilities: viewUnavailableCapabilities,
	});
	const textAreaRef = useRef<TextareaRenderable>(null);
	const composerDocument = useMemo(createComposerDocument, []);
	const ctrlCRef = useRef<() => boolean>(() => false);
	const lastRecallRevisionRef = useRef(recallRevision);
	const onSubmitRef = useRef<() => Promise<void>>(async () => undefined);
	const onEmptySubmitRef = useLatest(onEmptySubmit);
	const pasteIntake = useMemo(createPasteIntake, []);
	const fileMentionExtmarkIdsRef = useRef<number[]>([]);
	const syncFileMentionExtmarksRef = useRef<() => void>(() => undefined);

	const { isTopLayer, pop, push, setResponder } = useKeyboardLayer();
	const { colors } = useTheme();
	const clipboard = useClipboard();
	const { show } = useToast();
	const commandControllerFactory = useCommandControllerFactory();
	const mentionSyntaxStyle = useSyntaxStyle("composer");
	const composerStyleIdsRef = useLatest({
		attachment: mentionSyntaxStyle.getStyleId("attachment") ?? undefined,
		pastedText: mentionSyntaxStyle.getStyleId("pastedText") ?? undefined,
	});

	const attachTextArea = useCallback(
		(textarea: TextareaRenderable | null) => {
			textAreaRef.current = textarea;
			if (textarea) {
				attachComposerDocumentToTextarea(
					composerDocument,
					textarea,
					() => composerStyleIdsRef.current
				);
				registerClipboardTextTransform(textarea, (text: string) => {
					const selection = textarea.getSelection();
					const pastedText = composerDocument.capture().pastedText;
					if (!selection) {
						return expandPastedText(text, pastedText);
					}
					if (textarea.getSelectedText() !== text) {
						return text;
					}
					return expandPastedTextInRange(
						text,
						selection,
						pastedText.map(({ start, text: pasted, token }) => ({
							end: start + token.length,
							start,
							text: pasted,
							token,
						}))
					);
				});
			} else {
				composerDocument.attachEditor(null);
			}
		},
		[composerDocument]
	);

	const handleSubmitError = useCallback(
		(message: string) => {
			show({ message, variant: "error" });
		},
		[show]
	);
	const commandController = useMemo(
		() =>
			commandControllerFactory.create({
				unavailableCapabilities: unavailableCommandCapabilities,
				sessionId,
				onCompact,
				onError: handleSubmitError,
				onOpenSettings,
				onSelectProviderModel: setFutureProviderModelSelection,
				providerController,
				providerModel: selectedProviderModel,
			}),
		[
			commandControllerFactory,
			handleSubmitError,
			onCompact,
			onOpenSettings,
			sessionId,
			setFutureProviderModelSelection,
			providerController,
			selectedProviderModel,
			unavailableCommandCapabilities,
		]
	);
	const { actions, state } = useChatInputController({
		composerDocument,
		disabled,
		commandController,
		draftKey,
		getFileMentionOptions,
		onSubmit,
		onTab: (shift) => {
			if (shift) {
				cycleThinkingLevel(selectedProviderModel);
			}
		},
		sessionPromptHistory,
	});
	const commandEscapeRef = useLatest(actions.onEscape);

	const handleTextareaContentChange = useCallback(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		const editorChange = composerDocument.observeEditorChange();
		if (!editorChange) {
			return;
		}
		const { previousText, snapshot: observedSnapshot } = editorChange;
		const mentionDelete = isNull(state.overlay.kind)
			? deleteFileMentionAfterTrailingCharacterDelete(
					previousText,
					textarea.plainText,
					textarea.cursorOffset
				)
			: null;
		if (mentionDelete) {
			const snapshot = composerDocument.replaceText(
				mentionDelete.text,
				mentionDelete.cursorOffset
			);
			actions.onTextChange(snapshot, snapshot.cursorOffset, previousText);
			syncFileMentionExtmarksRef.current();
			return;
		}

		actions.onTextChange(
			observedSnapshot,
			observedSnapshot.cursorOffset,
			previousText
		);
		syncFileMentionExtmarksRef.current();
	}, [actions, composerDocument, state.overlay.kind]);

	const syncFileMentionExtmarks = useCallback(() => {
		const textarea = textAreaRef.current;
		const styleId = mentionSyntaxStyle.getStyleId("fileMention");
		if (!(textarea && !isNull(styleId))) {
			return;
		}

		const ranges = findFileMentionRanges(textarea.plainText);
		const extmarks = fileMentionExtmarkIdsRef.current.map((id) =>
			textarea.extmarks.get(id)
		);
		if (areFileMentionExtmarksCurrent(ranges, extmarks, styleId)) {
			return;
		}

		for (const id of fileMentionExtmarkIdsRef.current) {
			textarea.extmarks.delete(id);
		}
		fileMentionExtmarkIdsRef.current = ranges.map((range) =>
			textarea.extmarks.create({
				end: range.end,
				priority: 10,
				start: range.start,
				styleId,
				typeId: 2,
			})
		);
	}, [mentionSyntaxStyle]);
	syncFileMentionExtmarksRef.current = syncFileMentionExtmarks;

	useEffect(() => {
		if (lastRecallRevisionRef.current === recallRevision) {
			return;
		}
		lastRecallRevisionRef.current = recallRevision;
		if (recalledSubmissions.length === 0) {
			return;
		}
		actions.recall(recalledSubmissions, composerDocument.capture());
	}, [actions.recall, composerDocument, recalledSubmissions, recallRevision]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.syntaxStyle = mentionSyntaxStyle;
		composerDocument.refreshStyles();

		for (const id of fileMentionExtmarkIdsRef.current) {
			textarea.extmarks.delete(id);
		}
		fileMentionExtmarkIdsRef.current = [];
		syncFileMentionExtmarks();
	}, [composerDocument, mentionSyntaxStyle, syncFileMentionExtmarks]);

	useEffect(() => {
		if (composerDocument.capture().text === state.text) {
			syncFileMentionExtmarks();
		}
	}, [composerDocument, state.text, syncFileMentionExtmarks]);

	useEffect(() => {
		const textarea = textAreaRef.current;
		if (!textarea) {
			return;
		}

		textarea.onSubmit = async () => {
			await onSubmitRef.current();
		};
	}, []);

	onSubmitRef.current = async () => {
		const overlay = state.overlay;
		if (
			overlay.kind !== null &&
			(overlay.kind !== "command" || overlay.items.length > 0)
		) {
			actions.onEnter();
			return;
		}

		const snapshot = composerDocument.capture();
		const rawText = snapshot.text;
		const pastedTexts = snapshot.pastedText.map(({ start, text, token }) => ({
			end: start + token.length,
			start,
			text,
			token,
		}));
		const files = snapshot.files;
		const fileTokens = snapshot.fileTokens;
		const submitEmpty = onEmptySubmitRef.current;
		if (
			submitEmpty &&
			rawText.trim().length === 0 &&
			files.length === 0 &&
			pastedTexts.length === 0
		) {
			await submitEmpty();
			return;
		}
		const accepted = await actions.submit({
			fileTokens: normalizeFileTokensForTrimmedText(rawText, fileTokens),
			files: [...files],
			pastedTexts,
			rawText,
		});
		if (!accepted) {
			return;
		}
	};
	ctrlCRef.current = () => actions.onCtrlC(composerDocument.capture());

	useEffect(() => {
		if (isNull(state.overlay.kind)) {
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

	const applyTextPaste = useCallback(
		(event: PasteEvent) => {
			const textarea = textAreaRef.current;
			if (!textarea) {
				return;
			}

			textarea.handlePaste(event);
			handleTextareaContentChange();
		},
		[handleTextareaContentChange]
	);

	usePaste((event) => {
		pasteIntake
			.handle(event, {
				active: !disabled && (isTopLayer("base") || isTopLayer("command")),
				applyTextPaste,
				document: composerDocument,
				onDocumentChange: handleTextareaContentChange,
				onError: (message) => show({ message, variant: "error" }),
				readClipboardImage: () => readClipboardImage(clipboard),
				readImagePath: (text) =>
					readImagePath(text, {
						readFile: (imagePath) => Bun.file(imagePath).bytes(),
						stat: async (imagePath) => fs.stat(imagePath),
					}),
			})
			.catch(() => applyTextPaste(event));
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard priority branches are intentionally co-located.
	useKeyboard((key) => {
		if (disabled) {
			return;
		}

		if (!isNull(state.overlay.kind) && isTopLayer("command")) {
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

		if (
			isTopLayer("base") &&
			key.ctrl === false &&
			key.shift === false &&
			key.meta === false &&
			key.option === false &&
			(key.name === "up" || key.name === "down")
		) {
			const textarea = textAreaRef.current;
			if (textarea) {
				const consumed = (
					key.name === "up" ? actions.onArrowUp : actions.onArrowDown
				)(textarea.cursorOffset, textarea.plainText.length);
				if (consumed) {
					key.preventDefault();
				}
			}
			return;
		}

		if (
			key.name === "tab" &&
			!isNull(state.overlay.kind) &&
			isTopLayer("command")
		) {
			key.preventDefault();
			actions.onTab(key.shift);
			return;
		}

		if (!isTopLayer("base")) {
			return;
		}

		if (key.name === "tab") {
			key.preventDefault();
			actions.onTab(key.shift);
		}
	});

	const isFocused = !disabled && (isTopLayer("base") || isTopLayer("command"));
	const selectedThinkingLevel =
		statusBarThinkingSelection?.thinkingLevel ?? thinkingLevel;
	const defaultBorderColor = isFocused ? colors.borderActive : colors.border;
	const borderColor =
		composerBorderColor ??
		(selectedThinkingLevel === undefined
			? defaultBorderColor
			: getThinkingLevelBorderColor(colors, selectedThinkingLevel));
	const showStatusBar =
		isProviderStatusReady &&
		isSelectionReady &&
		(selectedProviderModel === undefined ||
			!hasThinkingLevels ||
			thinkingLevel !== undefined ||
			statusBarThinkingSelection?.thinkingLevel !== undefined);

	return (
		<box
			alignItems="center"
			overflow="visible"
			position="relative"
			width="100%"
		>
			{state.overlay.kind === "command" && (
				<box bottom="100%" left={0} position="absolute" right={0} zIndex={10}>
					<BorderedContentBlock
						border={["left", "right"]}
						borderColor={colors.borderActive}
						colors={colors}
						contentGap={0}
						customBorderChars={{ vertical: "┃" }}
						marginBottom={0}
						paddingX={0}
						paddingY={0}
					>
						<SelectableList
							emptyMessage="No matching commands"
							items={state.overlay.items.map(toSelectableCommandItem)}
							onConfirm={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
							widthBasis={state.overlay.allItems.map(toSelectableCommandItem)}
						/>
					</BorderedContentBlock>
				</box>
			)}

			{state.overlay.kind === "file-mention" && (
				<box bottom="100%" left={0} position="absolute" right={0} zIndex={10}>
					<BorderedContentBlock
						border={["left", "right"]}
						borderColor={colors.borderActive}
						colors={colors}
						contentGap={0}
						customBorderChars={{ vertical: "┃" }}
						marginBottom={0}
						paddingX={0}
						paddingY={0}
					>
						<SelectableList
							emptyMessage="No matching files"
							items={state.overlay.items.map(toSelectableFileMentionItem)}
							onConfirm={actions.onItemExecute}
							onSelect={actions.onItemSelect}
							selectedIndex={state.overlay.selectedIndex}
						/>
					</BorderedContentBlock>
				</box>
			)}

			<ComposerTopBorder
				activityIndicator={activityIndicator}
				borderColor={borderColor}
				statusBar={
					showStatusBar ? (
						<StatusBar thinkingSelection={statusBarThinkingSelection} />
					) : undefined
				}
			/>
			<BorderedContentBlock
				border={["left", "right", "bottom"]}
				borderColor={borderColor}
				colors={colors}
				contentBackgroundColor="transparent"
				contentGap={0}
				contentJustifyContent="center"
				customBorderChars={RoundedBorderChars}
				marginBottom={0}
				paddingX={1}
				paddingY={0}
			>
				<box flexDirection="row" gap={1} width="100%">
					<textarea
						flexGrow={1}
						focused={isFocused}
						focusedTextColor={disabled ? colors.textDisabled : colors.text}
						id={id}
						keyBindings={CHAT_TEXT_AREA_KEY_BINDINGS}
						onContentChange={handleTextareaContentChange}
						placeholder={"Ask anything..."}
						placeholderColor={colors.textMuted}
						ref={attachTextArea}
						textColor={disabled ? colors.textDisabled : colors.text}
					/>
				</box>
			</BorderedContentBlock>
		</box>
	);
}
