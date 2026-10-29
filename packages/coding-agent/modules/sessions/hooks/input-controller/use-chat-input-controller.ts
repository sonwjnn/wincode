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
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import { useLatest } from "@/shared/hooks/use-latest";
import { normalizeFileTokensForTrimmedText } from "../../attachments";
import {
	normalizePastedTextRangesForTrimmedText,
	shiftPastedTextRangesForTrimmedText,
} from "../../pasted-text";
import { getSessionStore } from "../../storage/get-session-store";
import type { ChatPromptComposition } from "../../utils";
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
	normalizeCommandSelectionsForTrimmedText,
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

type RecalledCompositionAccumulator = {
	commandSelections: TrackedCommandSelection[];
	fileTokens: Array<{ start: number; token: string }>;
	files: ChatPromptComposition["files"][number][];
	pastedText: NonNullable<ChatPromptComposition["pastedText"]>[number][];
	text: string;
};

const normalizeDraftForRecall = (
	draft: ChatPromptComposition
): ChatPromptComposition => ({
	commandSelections: normalizeCommandSelectionsForTrimmedText(
		draft.text,
		draft.commandSelections ?? []
	),
	fileTokens: normalizeFileTokensForTrimmedText(draft.text, [
		...(draft.fileTokens ?? []),
	]),
	files: draft.files,
	pastedText: shiftPastedTextRangesForTrimmedText(
		draft.text,
		draft.pastedText ?? []
	),
	text: draft.text.trim(),
});

const hasCompositionContent = (composition: ChatPromptComposition): boolean =>
	composition.text.length > 0 || composition.files.length > 0;

const appendRecalledComposition = (
	accumulator: RecalledCompositionAccumulator,
	composition: ChatPromptComposition
): void => {
	if (accumulator.text.length > 0) {
		accumulator.text += "\n\n";
	}
	const base = accumulator.text.length;
	accumulator.text += composition.text;
	for (const { start, token } of composition.fileTokens ?? []) {
		accumulator.fileTokens.push({ start: base + start, token });
	}
	accumulator.files.push(...composition.files);
	for (const pasted of composition.pastedText ?? []) {
		accumulator.pastedText.push({ ...pasted, start: base + pasted.start });
	}
	for (const selection of composition.commandSelections ?? []) {
		accumulator.commandSelections.push({
			...selection,
			end: base + selection.end,
			start: base + selection.start,
		});
	}
};

const combineRecalledCompositions = (
	draft: ChatPromptComposition,
	entries: readonly ChatPromptComposition[]
): RecalledCompositionAccumulator | null => {
	const compositions = [normalizeDraftForRecall(draft), ...entries].filter(
		hasCompositionContent
	);
	if (compositions.length === 0) {
		return null;
	}
	const accumulator: RecalledCompositionAccumulator = {
		commandSelections: [],
		fileTokens: [],
		files: [],
		pastedText: [],
		text: "",
	};
	for (const composition of compositions) {
		appendRecalledComposition(accumulator, composition);
	}
	return accumulator;
};

export function useChatInputController({
	composerDocument,
	disabled,
	commandController,
	draftKey,
	getFileMentionOptions: getFileMentionOptionsFromOptions,
	onSubmit,
	onTab,
	sessionPromptHistory,
	promptHistoryStore,
}: ChatInputControllerOptions): ChatInputController {
	const initialDraft =
		draftKey === undefined ? "" : restoreComposerDraft(draftKey);
	const [textValue, setTextValue] = useState(
		() => composerDocument.replaceText(initialDraft, initialDraft.length).text
	);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [overlayKind, setOverlayKind] =
		useState<InputOverlayState["kind"]>(null);
	const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(
		null
	);
	const [fileMentionOptions, setFileMentionOptions] = useState<
		FileMentionOption[]
	>([]);
	const historyRef = useRef<PromptHistoryEntry[]>([]);
	const historyIndexRef = useRef(-1);
	const draftRef = useRef<PromptHistoryEntry>({
		files: [],
		text: initialDraft,
	});
	const promptRecordQueueRef = useRef(Promise.resolve());
	const selectionsRef = useRef<TrackedCommandSelection[]>([]);
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
	const rememberPrompt = useCallback(
		(entry: PromptHistoryEntry) => {
			const previousRecord = promptRecordQueueRef.current;
			const currentRecord = (async () => {
				await previousRecord;
				try {
					const store = promptHistoryStore ?? getSessionStore();
					const { commandSelections = [], ...storedEntry } = entry;
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
					const durableEntry = { ...storedEntry, files };
					await store.recordPrompt(durableEntry);
					historyRef.current = prependPrompt(historyRef.current, {
						...durableEntry,
						commandSelections,
					});
				} catch {
					// A prompt-history write must not retain an inline payload after failure.
				}
			})();
			promptRecordQueueRef.current = currentRecord;
		},
		[promptHistoryStore]
	);
	useEffect(() => {
		let active = true;
		void (promptHistoryStore ?? getSessionStore())
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
	}, [promptHistoryStore, sessionPromptHistory]);
	const selectedIndexRef = useLatest(selectedIndex);
	const onSubmitRef = useLatest(onSubmit);
	const setProgrammaticText = useCallback(
		(
			text: string,
			nextCursorOffset: number | null,
			nextSelections?: readonly TrackedCommandSelection[] | null,
			restoredComposition?: ChatPromptComposition
		) => {
			selectionsRef.current =
				nextSelections === undefined
					? applyTextEdit(
							selectionsRef.current,
							composerDocument.capture().text,
							text
						)
					: [...(nextSelections ?? [])];
			const snapshot =
				restoredComposition === undefined
					? composerDocument.replaceText(text, nextCursorOffset)
					: composerDocument.restore(restoredComposition, nextCursorOffset);
			if (historyIndexRef.current === -1) {
				draftRef.current = {
					commandSelections: [...selectionsRef.current],
					fileTokens: snapshot.fileTokens,
					files: [...snapshot.files],
					pastedText: snapshot.pastedText,
					text: snapshot.text,
				};
			}
			setTextValue(snapshot.text);
		},
		[composerDocument]
	);

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
			composition: SessionSubmissionComposition,
			cursorOffset: number,
			previousText: string
		) => {
			const { files, fileTokens, pastedText, text } = composition;
			historyIndexRef.current = -1;
			selectionsRef.current = applyTextEdit(
				selectionsRef.current,
				previousText,
				text
			);
			draftRef.current = {
				commandSelections: [...selectionsRef.current],
				fileTokens: fileTokens?.map((entry) => ({ ...entry })),
				files: [...files],
				pastedText: pastedText?.map((entry) => ({ ...entry })),
				text,
			};
			setTextValue(text);
			setSelectedIndex(0);

			const nextTrigger = detectTrigger(text, cursorOffset);
			setActiveTrigger(nextTrigger);
			setOverlayKind(nextTrigger?.kind ?? null);
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
				result.entry.commandSelections ?? [],
				{
					commandSelections: result.entry.commandSelections,
					fileTokens: result.entry.fileTokens,
					files: result.entry.files,
					pastedText: result.entry.pastedText,
					text: result.entry.text,
				}
			);
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
			entries: readonly ChatPromptComposition[],
			draft: ChatPromptComposition
		) => {
			const composition = combineRecalledCompositions(
				{
					...draft,
					commandSelections: draft.commandSelections ?? [
						...selectionsRef.current,
					],
				},
				entries
			);
			if (!composition) {
				return;
			}
			historyIndexRef.current = -1;
			draftRef.current = composition;
			setProgrammaticText(
				composition.text,
				0,
				composition.commandSelections,
				composition
			);
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
			const currentText = composerDocument.capture().text;
			const trigger = activeTrigger?.kind === "command" ? activeTrigger : null;
			const start = trigger?.start ?? currentText.length;
			const end = trigger?.end ?? currentText.length;
			// Keep one separator: the trailing space is only needed when the
			// trigger did not already sit before whitespace.
			const separator = commandInsertionSeparator(
				currentText,
				end,
				selection.reopen
			);
			const invocation = `${selection.invocation}${separator}`;
			const nextText = `${currentText.slice(0, start)}${invocation}${currentText.slice(end)}`;
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
				...applyTextEdit(selectionsRef.current, currentText, nextText),
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
		[activeTrigger, closeOverlay, composerDocument, setProgrammaticText]
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

			const currentText = composerDocument.capture().text;
			const nextText = activeTrigger
				? removeTriggerText(currentText, activeTrigger)
				: { cursorOffset: null, text: currentText };
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
			composerDocument,
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
				composerDocument.capture().text,
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
			composerDocument,
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
			const result = removeTriggerText(
				composerDocument.capture().text,
				activeTrigger
			);
			setProgrammaticText(result.text, result.cursorOffset);
		}
		closeOverlay();
	}, [activeTrigger, closeOverlay, composerDocument, setProgrammaticText]);

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
					commandSelections: normalizeCommandSelectionsForTrimmedText(
						snapshot.rawText,
						selectionsRef.current
					),
					fileTokens: snapshot.fileTokens,
					files: snapshot.files,
					pastedText: normalizePastedTextRangesForTrimmedText(
						snapshot.rawText,
						snapshot.pastedTexts.map(({ start, text, token }) => ({
							start,
							text,
							token,
						}))
					),
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
		(composition: SessionSubmissionComposition) => {
			const { files, pastedText, text } = composition;
			if (disabled || (text.length === 0 && isNull(overlayKind))) {
				return false;
			}
			if (
				shouldRecordCtrlC(
					text,
					files.length > 0 || (pastedText?.length ?? 0) > 0
				)
			) {
				rememberPrompt({
					commandSelections: [...selectionsRef.current],
					fileTokens: composition.fileTokens?.map((entry) => ({ ...entry })),
					files: [...files],
					pastedText: pastedText?.map((entry) => ({ ...entry })),
					text,
				});
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
					setProgrammaticText(composerDocument.capture().text, 0);
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
			composerDocument,
		]
	);

	const onArrowDown = useCallback(
		(cursor?: number, length?: number): boolean => {
			if (isNull(overlayKind)) {
				if (
					!(isUndefined(cursor) || isUndefined(length)) &&
					decideDownAction(cursor, length) === "moveToEnd"
				) {
					setProgrammaticText(composerDocument.capture().text, length);
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
			composerDocument,
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
			recall,
			submit,
		},
		state: {
			overlay,
			text: textValue,
		},
	};
}
