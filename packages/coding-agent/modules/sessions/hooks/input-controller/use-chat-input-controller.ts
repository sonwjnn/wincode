import { isNull, isUndefined } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CommandSelection,
	CommandSuggestion,
	CommandSuggestionScope,
} from "@/modules/commands/command-controller";
import type { FileMentionOption } from "@/modules/file-mentions";
import {
	applyFileMentionReplacement,
	filterFileMentionOptions,
} from "@/modules/file-mentions";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import { useLatest } from "@/shared/hooks/use-latest";
import { normalizeFileTokensForTrimmedText } from "../../attachments";
import { getSessionStore } from "../../storage/get-session-store";
import { restoreComposerDraft, writeComposerDraft } from "./draft-store";
import { removeTriggerText } from "./escape-trigger";
import {
	decideDownAction,
	decideUpAction,
	navigateHistory as getHistoryNavigation,
	mergePromptHistory,
	type PromptHistoryEntry,
	prependPrompt,
	resetHistoryNavigation,
	shouldRecordCtrlC,
} from "./history";
import {
	applyTextEdit,
	commandInsertionSeparator,
	type TrackedCommandSelection,
} from "./selections";
import { preparePromptSubmission, type SubmitSnapshot } from "./submit";
import { type ActiveTrigger, detectTrigger } from "./triggers";
import type {
	ChatInputController,
	ChatInputControllerOptions,
	InputOverlayState,
} from "./types";

const EMPTY_OVERLAY: InputOverlayState = {
	items: [],
	kind: null,
	selectedIndex: -1,
};

export function useChatInputController({
	disabled,
	commandController,
	draftKey,
	getFileMentionOptions: getFileMentionOptionsFromOptions,
	onSubmit,
	onTab,
	sessionPromptHistory,
}: ChatInputControllerOptions): ChatInputController {
	const initialDraft =
		draftKey === undefined ? "" : restoreComposerDraft(draftKey);
	const [textValue, setTextValue] = useState(initialDraft);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [overlayKind, setOverlayKind] =
		useState<InputOverlayState["kind"]>(null);
	const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(
		null
	);
	const [cursorOffset, setCursorOffset] = useState<number | null>(
		initialDraft.length === 0 ? null : initialDraft.length
	);
	const [fileMentionOptions, setFileMentionOptions] = useState<
		FileMentionOption[]
	>([]);
	// A restored draft must reach the textarea, whose sync effect skips the
	// initial revision.
	const [textSyncRevision, setTextSyncRevision] = useState(
		initialDraft.length === 0 ? 0 : 1
	);
	const historyRef = useRef<PromptHistoryEntry[]>([]);
	const historyIndexRef = useRef(-1);
	const draftRef = useRef<PromptHistoryEntry>({
		files: [],
		text: initialDraft,
	});
	const promptRecordQueueRef = useRef(Promise.resolve());
	const selectionsRef = useRef<TrackedCommandSelection[]>([]);
	const textRef = useRef(initialDraft);
	useEffect(() => {
		if (draftKey === undefined) {
			return;
		}
		writeComposerDraft(draftKey, textValue);
	}, [draftKey, textValue]);
	const resetHistoryBaseline = useCallback((draft: string) => {
		const baseline = resetHistoryNavigation(draft);
		historyIndexRef.current = baseline.index;
		draftRef.current = baseline.draft;
	}, []);
	const rememberPrompt = useCallback((entry: PromptHistoryEntry) => {
		const previousRecord = promptRecordQueueRef.current;
		const currentRecord = (async () => {
			await previousRecord;
			try {
				const store = getSessionStore();
				const [externalized] = await store.externalizeAttachments([
					{
						id: "prompt-history",
						parts: entry.files,
						role: "user",
					} as unknown as SessionMessage,
				]);
				const files = (externalized?.parts ?? []).filter(
					(part): part is PromptHistoryEntry["files"][number] =>
						part.type === "file"
				);
				const durableEntry = { ...entry, files };
				await store.recordPrompt(durableEntry);
				historyRef.current = prependPrompt(historyRef.current, durableEntry);
			} catch {
				// A prompt-history write must not retain an inline payload after failure.
			}
		})();
		promptRecordQueueRef.current = currentRecord;
	}, []);
	useEffect(() => {
		let active = true;
		void getSessionStore()
			.getPromptHistory()
			.then((globalEntries) => {
				if (!active) {
					return;
				}
				const pendingEntries = historyRef.current;
				const mergedEntries = mergePromptHistory(
					sessionPromptHistory,
					globalEntries
				);
				historyRef.current = pendingEntries
					.toReversed()
					.reduce(
						(entries, entry) => prependPrompt(entries, entry),
						mergedEntries
					);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [sessionPromptHistory]);
	const selectedIndexRef = useLatest(selectedIndex);
	const onSubmitRef = useLatest(onSubmit);
	const setProgrammaticText = useCallback(
		(
			text: string,
			nextCursorOffset: number | null,
			nextSelections?: readonly TrackedCommandSelection[] | null
		) => {
			selectionsRef.current =
				nextSelections === undefined
					? applyTextEdit(selectionsRef.current, textRef.current, text)
					: [...(nextSelections ?? [])];
			textRef.current = text;
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

	const commandQuery =
		activeTrigger?.kind === "command" ? activeTrigger.query : undefined;
	const fileMentionQuery =
		activeTrigger?.kind === "file-mention" ? activeTrigger.query : undefined;
	const commandScope: CommandSuggestionScope =
		activeTrigger?.kind === "command" && activeTrigger.mode === "skill"
			? "skill"
			: "root";
	const commandSuggestions = useMemo(
		() =>
			isUndefined(commandQuery)
				? { allItems: [], items: [] }
				: commandController.getSuggestions(commandQuery, commandScope),
		[commandController, commandQuery, commandScope]
	);
	const filteredCommands = commandSuggestions.items;
	const filteredFileMentions = useMemo(
		() =>
			isUndefined(fileMentionQuery)
				? []
				: filterFileMentionOptions(fileMentionOptions, fileMentionQuery),
		[fileMentionOptions, fileMentionQuery]
	);

	const closeOverlay = useCallback(() => {
		setActiveTrigger(null);
		setOverlayKind(null);
		setSelectedIndex(0);
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
			selectionsRef.current = applyTextEdit(
				selectionsRef.current,
				textRef.current,
				text
			);
			textRef.current = text;
			setTextValue(text);
			setCursorOffset(null);
			setSelectedIndex(0);

			const nextTrigger = detectTrigger(text, cursorOffset);
			setActiveTrigger(nextTrigger);
			setOverlayKind(nextTrigger?.kind ?? null);
		},
		[]
	);
	const onProgrammaticTextChange = useCallback(
		(text: string, cursor: number) => {
			selectionsRef.current = applyTextEdit(
				selectionsRef.current,
				textRef.current,
				text
			);
			textRef.current = text;
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
				direction < 0 ? 0 : result.entry.text.length,
				null
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

	/**
	 * Restores recalled compositions through the same plumbing as history
	 * recall: programmatic text, recalled attachments, and recalled pasted
	 * text. The composer's own draft comes first and the recalled submissions
	 * follow it, oldest first, so recalling one at a time appends below what is
	 * already there and the queue keeps its order.
	 */
	const recall = useCallback(
		(
			entries: readonly SessionSubmissionComposition[],
			draft: SessionSubmissionComposition
		) => {
			const draftComposition: SessionSubmissionComposition = {
				fileTokens: normalizeFileTokensForTrimmedText(draft.text, [
					...(draft.fileTokens ?? []),
				]),
				files: draft.files,
				pastedText: draft.pastedText,
				text: draft.text.trim(),
			};
			const compositions = [draftComposition, ...entries].filter(
				(composition) =>
					composition.text.length > 0 || composition.files.length > 0
			);
			if (compositions.length === 0) {
				return;
			}
			let text = "";
			const fileTokens: Array<{ start: number; token: string }> = [];
			const files: SessionFilePart[] = [];
			const pastedText: Array<{ text: string; token: string }> = [];
			for (const composition of compositions) {
				if (text.length > 0) {
					text += "\n\n";
				}
				const base = text.length;
				text += composition.text;
				for (const { start, token } of composition.fileTokens ?? []) {
					fileTokens.push({ start: base + start, token });
				}
				files.push(...composition.files);
				pastedText.push(...(composition.pastedText ?? []));
			}

			historyIndexRef.current = -1;
			draftRef.current = { fileTokens, files, text };
			setProgrammaticText(text, 0, null);
			setRecalledFiles(files);
			setRecalledFileTokens(fileTokens);
			setRecalledFilesRevision((revision) => revision + 1);
			setRecalledPastedTexts(pastedText);
			setRecalledPastedTextsRevision((revision) => revision + 1);
		},
		[setProgrammaticText]
	);

	const resolveCommand = useCallback(
		(index: number): CommandSuggestion | undefined => {
			if (overlayKind !== "command") {
				return;
			}

			return filteredCommands[index];
		},
		[filteredCommands, overlayKind]
	);

	const applyCommandInsertion = useCallback(
		(selection: Extract<CommandSelection, { kind: "insert" }>) => {
			const trigger = activeTrigger?.kind === "command" ? activeTrigger : null;
			const start = trigger?.start ?? textValue.length;
			const end = trigger?.end ?? textValue.length;
			// Keep one separator: the trailing space is only needed when the
			// trigger did not already sit before whitespace.
			const separator = commandInsertionSeparator(
				textValue,
				end,
				selection.reopen
			);
			const invocation = `${selection.invocation}${separator}`;
			const nextText = `${textValue.slice(0, start)}${invocation}${textValue.slice(end)}`;
			const cursor = start + invocation.length;
			const tracked =
				selection.intent === undefined || selection.reopen
					? undefined
					: {
							end: start + selection.invocation.length,
							kind: selection.intent.kind,
							marker: selection.invocation,
							name: selection.intent.name,
							start,
						};
			const nextSelections = [
				...applyTextEdit(selectionsRef.current, textValue, nextText),
				...(tracked === undefined ? [] : [tracked]),
			];
			setProgrammaticText(nextText, cursor, nextSelections);
			if (selection.reopen) {
				const nextTrigger = detectTrigger(nextText, cursor);
				setActiveTrigger(nextTrigger);
				setOverlayKind(nextTrigger?.kind ?? null);
				setSelectedIndex(0);
				return;
			}
			closeOverlay();
		},
		[activeTrigger, closeOverlay, setProgrammaticText, textValue]
	);

	const selectCommandAtIndex = useCallback(
		(index: number, source: "enter" | "tab") => {
			const suggestion = resolveCommand(index);
			if (!suggestion) {
				return;
			}

			const selection = commandController.select(suggestion.id, source);
			if (!selection) {
				return;
			}

			if (selection.kind === "insert") {
				applyCommandInsertion(selection);
				return;
			}

			const nextText = activeTrigger
				? removeTriggerText(textValue, activeTrigger)
				: { cursorOffset: null, text: textValue };
			setProgrammaticText(nextText.text, nextText.cursorOffset);
			closeOverlay();
			void selection.execute();
		},
		[
			activeTrigger,
			applyCommandInsertion,
			closeOverlay,
			commandController,
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

			const isDirectory = option.type === "directory";
			const replacement = applyFileMentionReplacement(
				textValue,
				activeTrigger,
				`@${option.label}`,
				{ addTrailingSpace: !isDirectory }
			);
			setProgrammaticText(replacement.text, replacement.cursorOffset);

			if (isDirectory) {
				const nextTrigger = detectTrigger(
					replacement.text,
					replacement.cursorOffset
				);
				if (nextTrigger?.kind === "file-mention") {
					setActiveTrigger(nextTrigger);
					setOverlayKind("file-mention");
					setSelectedIndex(0);
					return;
				}
			}

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
			selectCommandAtIndex(selectedIndex, "enter");
			return;
		}

		if (overlayKind === "file-mention") {
			executeFileMentionAtIndex(selectedIndex);
		}
	}, [
		disabled,
		selectCommandAtIndex,
		executeFileMentionAtIndex,
		overlayKind,
		selectedIndex,
	]);

	const onEscape = useCallback(() => {
		if (activeTrigger?.kind === "file-mention") {
			const result = removeTriggerText(textValue, activeTrigger);
			setProgrammaticText(result.text, result.cursorOffset);
		}
		closeOverlay();
	}, [activeTrigger, closeOverlay, setProgrammaticText, textValue]);

	const submit = useCallback(
		async (snapshot: SubmitSnapshot): Promise<boolean> => {
			if (disabled) {
				return false;
			}

			const prepared = await preparePromptSubmission(
				{
					commandController,
					disabled,
					onSubmit: onSubmitRef.current,
					selections: selectionsRef.current,
				},
				snapshot
			);
			if (!prepared.accepted) {
				return false;
			}

			const prompt = snapshot.rawText.trim();
			if (prompt.length > 0) {
				rememberPrompt({
					fileTokens: snapshot.fileTokens,
					files: snapshot.files,
					pastedText: snapshot.pastedTexts.map(({ text, token }) => ({
						text,
						token,
					})),
					text: prompt,
				});
			}
			resetHistoryBaseline("");
			setProgrammaticText("", null, null);
			if (draftKey !== undefined) {
				// Submitting consumes the draft even if navigation unmounts this
				// composer before the write-back effect commits.
				writeComposerDraft(draftKey, "");
			}
			closeOverlay();
			await prepared.execute();
			return true;
		},
		[
			commandController,
			closeOverlay,
			disabled,
			draftKey,
			rememberPrompt,
			resetHistoryBaseline,
			setProgrammaticText,
		]
	);

	const onCtrlC = useCallback(
		(
			files: PromptHistoryEntry["files"],
			fileTokens: NonNullable<PromptHistoryEntry["fileTokens"]>,
			pastedText: NonNullable<PromptHistoryEntry["pastedText"]>
		) => {
			if (disabled || (textValue.length === 0 && isNull(overlayKind))) {
				return false;
			}
			if (
				shouldRecordCtrlC(textValue, files.length > 0 || pastedText.length > 0)
			) {
				rememberPrompt({ fileTokens, files, pastedText, text: textValue });
			}

			resetHistoryBaseline("");
			setProgrammaticText("", null, null);
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
			if (isNull(overlayKind)) {
				if (isUndefined(cursor)) {
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
			if (isNull(overlayKind)) {
				if (
					!(isUndefined(cursor) || isUndefined(length)) &&
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
			if (isNull(overlayKind)) {
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
				selectCommandAtIndex(index, "enter");
				return;
			}

			if (overlayKind === "file-mention") {
				executeFileMentionAtIndex(index);
			}
		},
		[disabled, executeFileMentionAtIndex, overlayKind, selectCommandAtIndex]
	);

	const handleTab = useCallback(
		(shift: boolean) => {
			if (disabled) {
				return;
			}

			if (!shift && overlayKind === "file-mention") {
				executeFileMentionAtIndex(selectedIndex);
				return;
			}

			if (!shift && overlayKind === "command") {
				selectCommandAtIndex(selectedIndex, "tab");
				return;
			}

			onTab(shift);
		},
		[
			disabled,
			executeFileMentionAtIndex,
			onTab,
			overlayKind,
			selectCommandAtIndex,
			selectedIndex,
		]
	);

	let overlay: InputOverlayState = EMPTY_OVERLAY;
	if (overlayKind === "command") {
		overlay = {
			allItems: commandSuggestions.allItems,
			items: filteredCommands,
			kind: "command",
			selectedIndex,
		};
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
			onCtrlC,
			onEnter,
			onEscape,
			onItemExecute,
			onItemSelect,
			onTab: handleTab,
			onTextChange,
			onProgrammaticTextChange,
			recall,
			submit,
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
		},
	};
}
