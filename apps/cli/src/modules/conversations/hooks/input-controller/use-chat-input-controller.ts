import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFilteredCommands } from "@/modules/commands/filter-commands";
import { extractArguments } from "@/modules/custom-commands/expand";
import { filterCustomCommands } from "@/modules/custom-commands/filter";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { FileMentionOption } from "@/modules/file-mentions";
import {
	applyFileMentionReplacement,
	filterFileMentionOptions,
} from "@/modules/file-mentions";
import { removeTriggerText } from "./escape-trigger";
import {
	decideDownAction,
	decideUpAction,
	navigateHistory as getHistoryNavigation,
	type PromptHistoryEntry,
	prependPrompt,
	resetHistoryNavigation,
	shouldRecordCtrlC,
} from "./history";
import { type ActiveTrigger, detectTrigger } from "./triggers";
import type {
	ChatInputController,
	ChatInputControllerOptions,
	CommandItem,
	InputOverlayState,
} from "./types";

const MAX_VISIBLE_ITEMS = 8;

const EMPTY_OVERLAY: InputOverlayState = {
	items: [],
	kind: null,
	selectedIndex: -1,
};

export function useChatInputController({
	disabled,
	executeCommand,
	getCustomCommands: getCustomCommandsFromOptions,
	getFileMentionOptions: getFileMentionOptionsFromOptions,
	onSubmit,
	onTab,
	getPromptHistory,
	recordPrompt,
}: ChatInputControllerOptions): ChatInputController {
	const [textValue, setTextValue] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [overlayKind, setOverlayKind] =
		useState<InputOverlayState["kind"]>(null);
	const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(
		null
	);
	const [cursorOffset, setCursorOffset] = useState<number | null>(null);
	const [fileMentionOptions, setFileMentionOptions] = useState<
		FileMentionOption[]
	>([]);
	const [customCommands, setCustomCommands] = useState<CustomCommandSpec[]>([]);
	const [textSyncRevision, setTextSyncRevision] = useState(0);
	const [visibleStartIndex, setVisibleStartIndex] = useState(0);
	const historyRef = useRef<PromptHistoryEntry[]>([]);
	const historyIndexRef = useRef(-1);
	const draftRef = useRef<PromptHistoryEntry>({ text: "", files: [] });
	const resetHistoryBaseline = useCallback((draft: string) => {
		const baseline = resetHistoryNavigation(draft);
		historyIndexRef.current = baseline.index;
		draftRef.current = baseline.draft;
	}, []);
	const rememberPrompt = useCallback(
		(entry: PromptHistoryEntry) => {
			recordPrompt(entry);
			historyRef.current = prependPrompt(historyRef.current, entry);
		},
		[recordPrompt]
	);
	useEffect(() => {
		historyRef.current = getPromptHistory();
	}, [getPromptHistory]);
	const selectedIndexRef = useRef(0);
	selectedIndexRef.current = selectedIndex;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const setProgrammaticText = useCallback(
		(text: string, nextCursorOffset: number | null) => {
			setTextValue(text);
			setCursorOffset(nextCursorOffset);
			setTextSyncRevision((revision) => revision + 1);
		},
		[]
	);
	const [recalledFiles, setRecalledFiles] = useState<
		PromptHistoryEntry["files"]
	>([]);
	const [recalledFileTokens, setRecalledFileTokens] = useState<
		NonNullable<PromptHistoryEntry["fileTokens"]>
	>([]);
	const [recalledFilesRevision, setRecalledFilesRevision] = useState(0);
	const [recalledPastedTexts, setRecalledPastedTexts] = useState<
		NonNullable<PromptHistoryEntry["pastedText"]>
	>([]);
	const [recalledPastedTextsRevision, setRecalledPastedTextsRevision] =
		useState(0);

	useEffect(() => {
		let active = true;

		getFileMentionOptionsFromOptions()
			.then((options) => {
				if (active) {
					setFileMentionOptions(options);
				}
			})
			.catch(() => {
				if (active) {
					setFileMentionOptions([]);
				}
			});

		return () => {
			active = false;
		};
	}, [getFileMentionOptionsFromOptions]);

	const commandOverlayOpen = overlayKind === "command";
	useEffect(() => {
		if (!commandOverlayOpen) {
			return;
		}
		let active = true;

		getCustomCommandsFromOptions()
			.then((specs) => {
				if (active) {
					setCustomCommands(specs);
				}
			})
			.catch(() => {
				if (active) {
					setCustomCommands([]);
				}
			});

		return () => {
			active = false;
		};
	}, [commandOverlayOpen, getCustomCommandsFromOptions]);

	const commandQuery =
		activeTrigger?.kind === "command" ? activeTrigger.query : undefined;
	const fileMentionQuery =
		activeTrigger?.kind === "file-mention" ? activeTrigger.query : undefined;
	const filteredCommands = useMemo(
		() =>
			commandQuery === undefined
				? []
				: [
						...getFilteredCommands(commandQuery),
						...filterCustomCommands(customCommands, commandQuery),
					],
		[commandQuery, customCommands]
	);
	const filteredFileMentions = useMemo(
		() =>
			fileMentionQuery === undefined
				? []
				: filterFileMentionOptions(fileMentionOptions, fileMentionQuery),
		[fileMentionOptions, fileMentionQuery]
	);

	const closeOverlay = useCallback(() => {
		setActiveTrigger(null);
		setOverlayKind(null);
		setSelectedIndex(0);
		setVisibleStartIndex(0);
	}, []);

	const onTextChange = useCallback(
		(
			text: string,
			cursorOffset: number,
			files: PromptHistoryEntry["files"],
			fileTokens: NonNullable<PromptHistoryEntry["fileTokens"]>
		) => {
			historyIndexRef.current = -1;
			draftRef.current = { fileTokens, files, text };
			setTextValue(text);
			setCursorOffset(null);
			setSelectedIndex(0);
			setVisibleStartIndex(0);

			const nextTrigger = detectTrigger(text, cursorOffset);
			setActiveTrigger(nextTrigger);
			setOverlayKind(nextTrigger?.kind ?? null);
		},
		[]
	);
	const onProgrammaticTextChange = useCallback(
		(text: string, cursor: number) => {
			setTextValue(text);
			setCursorOffset(cursor);
		},
		[]
	);

	const navigateHistory = useCallback(
		(direction: -1 | 1): boolean => {
			const result = getHistoryNavigation(
				{
					draft: draftRef.current,
					entries: historyRef.current,
					index: historyIndexRef.current,
				},
				direction < 0 ? "up" : "down"
			);
			if (!result.consumed) {
				return false;
			}
			historyIndexRef.current = result.state.index;
			setProgrammaticText(
				result.entry.text,
				direction < 0 ? 0 : result.entry.text.length
			);
			setRecalledFiles(result.entry.files);
			setRecalledFileTokens(result.entry.fileTokens ?? []);
			setRecalledFilesRevision((revision) => revision + 1);
			setRecalledPastedTexts(result.entry.pastedText ?? []);
			setRecalledPastedTextsRevision((revision) => revision + 1);
			return true;
		},
		[setProgrammaticText]
	);

	const resolveCommand = useCallback(
		(index: number): CommandItem | undefined => {
			if (overlayKind !== "command") {
				return;
			}

			return filteredCommands[index];
		},
		[filteredCommands, overlayKind]
	);

	const executeCommandAtIndex = useCallback(
		(index: number) => {
			const command = resolveCommand(index);
			if (!command) {
				return;
			}

			if (command.kind === "custom") {
				const args = activeTrigger ? extractArguments(activeTrigger.query) : "";
				const invocation = `/${command.name}${args ? ` ${args}` : " "}`;
				setProgrammaticText(invocation, invocation.length);
				closeOverlay();
				return;
			}

			const nextText = activeTrigger
				? removeTriggerText(textValue, activeTrigger)
				: { cursorOffset: null, text: textValue };
			setProgrammaticText(nextText.text, nextText.cursorOffset);
			executeCommand(command);
			closeOverlay();
		},
		[
			activeTrigger,
			closeOverlay,
			executeCommand,
			resolveCommand,
			setProgrammaticText,
			textValue,
		]
	);

	const executeFileMentionAtIndex = useCallback(
		(index: number) => {
			if (overlayKind !== "file-mention") {
				return;
			}

			const option = filteredFileMentions[index];
			if (!option) {
				return;
			}

			if (activeTrigger?.kind !== "file-mention") {
				return;
			}

			const replacement = applyFileMentionReplacement(
				textValue,
				activeTrigger,
				`@${option.label}`
			);
			setProgrammaticText(replacement.text, replacement.cursorOffset);
			closeOverlay();
		},
		[
			activeTrigger,
			closeOverlay,
			filteredFileMentions,
			overlayKind,
			setProgrammaticText,
			textValue,
		]
	);

	const onEnter = useCallback(() => {
		if (disabled) {
			return;
		}

		if (overlayKind === "command") {
			executeCommandAtIndex(selectedIndex);
			return;
		}

		if (overlayKind === "file-mention") {
			executeFileMentionAtIndex(selectedIndex);
			return;
		}

		const text = textValue.trim();
		if (text.length === 0) {
			return;
		}

		onSubmitRef.current(text);
		rememberPrompt({ text, files: [] });
		resetHistoryBaseline("");
		setProgrammaticText("", null);
		closeOverlay();
	}, [
		closeOverlay,
		disabled,
		executeCommandAtIndex,
		executeFileMentionAtIndex,
		overlayKind,
		selectedIndex,
		setProgrammaticText,
		textValue,
		rememberPrompt,
		resetHistoryBaseline,
	]);

	const onEscape = useCallback(() => {
		if (activeTrigger) {
			const result = removeTriggerText(textValue, activeTrigger);
			setProgrammaticText(result.text, result.cursorOffset);
		}
		closeOverlay();
	}, [activeTrigger, closeOverlay, setProgrammaticText, textValue]);

	const onAcceptedSubmit = useCallback(
		(entry: PromptHistoryEntry) => {
			const prompt = entry.text.trim();
			if (prompt.length > 0) {
				rememberPrompt({ ...entry, text: prompt });
			}
			resetHistoryBaseline("");
			setProgrammaticText("", null);
			closeOverlay();
		},
		[closeOverlay, rememberPrompt, resetHistoryBaseline, setProgrammaticText]
	);

	const onCtrlC = useCallback(
		(
			files: PromptHistoryEntry["files"],
			fileTokens: NonNullable<PromptHistoryEntry["fileTokens"]>,
			pastedText: NonNullable<PromptHistoryEntry["pastedText"]>
		) => {
			if (disabled || (textValue.length === 0 && overlayKind === null)) {
				return false;
			}
			if (
				shouldRecordCtrlC(textValue, files.length > 0 || pastedText.length > 0)
			) {
				rememberPrompt({ fileTokens, files, pastedText, text: textValue });
			}

			resetHistoryBaseline("");
			setProgrammaticText("", null);
			closeOverlay();
			return true;
		},
		[
			closeOverlay,
			disabled,
			overlayKind,
			setProgrammaticText,
			textValue,
			rememberPrompt,
			resetHistoryBaseline,
		]
	);

	const onArrowUp = useCallback(
		(cursor?: number, _textLength?: number): boolean => {
			if (overlayKind === null) {
				if (cursor === undefined) {
					return false;
				}
				if (decideUpAction(cursor) === "moveToStart") {
					setProgrammaticText(textValue, 0);
					return true;
				}
				return navigateHistory(-1);
			}

			const itemsLength =
				overlayKind === "command"
					? filteredCommands.length
					: filteredFileMentions.length;
			if (itemsLength === 0) {
				return false;
			}

			const nextIndex =
				selectedIndexRef.current <= 0
					? itemsLength - 1
					: selectedIndexRef.current - 1;
			selectedIndexRef.current = nextIndex;
			setSelectedIndex(nextIndex);
			setVisibleStartIndex((start) =>
				nextIndex < start || nextIndex >= start + MAX_VISIBLE_ITEMS
					? Math.max(0, nextIndex - MAX_VISIBLE_ITEMS + 1)
					: start
			);
			return true;
		},
		[
			filteredCommands.length,
			filteredFileMentions.length,
			navigateHistory,
			overlayKind,
			setProgrammaticText,
			textValue,
		]
	);

	const onArrowDown = useCallback(
		(cursor?: number, length?: number): boolean => {
			if (overlayKind === null) {
				if (
					cursor !== undefined &&
					length !== undefined &&
					decideDownAction(cursor, length) === "moveToEnd"
				) {
					setProgrammaticText(textValue, length);
					return true;
				}
				if (cursor !== length) {
					return false;
				}
				return navigateHistory(1);
			}

			const itemsLength =
				overlayKind === "command"
					? filteredCommands.length
					: filteredFileMentions.length;

			if (itemsLength === 0) {
				return false;
			}

			const nextIndex =
				selectedIndexRef.current >= itemsLength - 1
					? 0
					: selectedIndexRef.current + 1;
			selectedIndexRef.current = nextIndex;
			setSelectedIndex(nextIndex);
			setVisibleStartIndex((start) => {
				if (nextIndex < start) {
					return 0;
				}
				if (nextIndex >= start + MAX_VISIBLE_ITEMS) {
					return nextIndex - MAX_VISIBLE_ITEMS + 1;
				}
				return start;
			});
			return true;
		},
		[
			filteredCommands.length,
			filteredFileMentions.length,
			navigateHistory,
			overlayKind,
			setProgrammaticText,
			textValue,
		]
	);

	const onItemSelect = useCallback(
		(index: number) => {
			if (overlayKind === null) {
				return;
			}

			setSelectedIndex(index);
		},
		[overlayKind]
	);

	const onItemExecute = useCallback(
		(index: number) => {
			if (disabled) {
				return;
			}

			if (overlayKind === "command") {
				executeCommandAtIndex(index);
				return;
			}

			if (overlayKind === "file-mention") {
				executeFileMentionAtIndex(index);
			}
		},
		[disabled, executeCommandAtIndex, executeFileMentionAtIndex, overlayKind]
	);

	const handleTab = useCallback(() => {
		if (disabled) {
			return;
		}

		onTab();
	}, [disabled, onTab]);

	let overlay: InputOverlayState = EMPTY_OVERLAY;
	if (overlayKind === "command") {
		overlay = { items: filteredCommands, kind: "command", selectedIndex };
	} else if (overlayKind === "file-mention") {
		overlay = {
			items: filteredFileMentions,
			kind: "file-mention",
			selectedIndex,
		};
	}

	return {
		actions: {
			onArrowDown,
			onArrowUp,
			onAcceptedSubmit,
			onCtrlC,
			onEnter,
			onEscape,
			onItemExecute,
			onItemSelect,
			onTab: handleTab,
			onTextChange,
			onProgrammaticTextChange,
		},
		state: {
			cursorOffset,
			overlay,
			text: textValue,
			textSyncRevision,
			recalledFiles,
			recalledFileTokens,
			recalledFilesRevision,
			recalledPastedTexts,
			recalledPastedTextsRevision,
			visibleStartIndex,
		},
	};
}
