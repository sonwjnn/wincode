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
	PluginAutocompleteContext,
	PluginAutocompleteItem,
	PluginAutocompleteProvider,
	PluginAutocompleteProviderFactory,
} from "@/modules/plugins/public";
import {
	createPluginAutocompleteContext,
	wrapPluginAutocompleteProviders,
} from "@/modules/plugins/ui/plugin-autocomplete";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import { useLatest } from "@/shared/hooks/use-latest";
import { normalizeFileTokensForTrimmedText } from "../../attachments";
import {
	normalizePastedTextRangesForTrimmedText,
	shiftPastedTextRangesForTrimmedText,
} from "../../pasted-text";
import {
	getPromptHistoryStore,
	getSessionAttachments,
} from "../../storage/get-session-storage";
import type { PromptHistoryStore } from "../../storage/prompt-history";
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
const EMPTY_PLUGIN_AUTOCOMPLETE_PROVIDERS: readonly PluginAutocompleteProviderFactory[] =
	[];

type PluginCompletionState =
	| Readonly<{
			context: PluginAutocompleteContext;
			cursorOffset: number;
			items: readonly PluginAutocompleteItem[];
			kind: "autocomplete";
			prefix: string;
			provider: PluginAutocompleteProvider;
			text: string;
	  }>
	| Readonly<{
			cursorOffset: number;
			items: readonly PluginAutocompleteItem[];
			kind: "argument";
			prefix: string;
			text: string;
	  }>;

const getVisibleOverlayKind = (
	completion: PluginCompletionState | null,
	overlayKind: InputOverlayState["kind"]
): InputOverlayState["kind"] => {
	if (completion?.kind === "argument") {
		return "plugin-argument";
	}
	if (completion?.kind === "autocomplete") {
		return "plugin-autocomplete";
	}
	return overlayKind;
};

const getOverlayItemsLength = (
	kind: InputOverlayState["kind"],
	commandItems: number,
	fileMentionItems: number,
	pluginItems: number
): number => {
	if (kind === "command") {
		return commandItems;
	}
	if (kind === "file-mention") {
		return fileMentionItems;
	}
	if (kind === "plugin-autocomplete" || kind === "plugin-argument") {
		return pluginItems;
	}
	return 0;
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
	pluginAutocompleteProviders = EMPTY_PLUGIN_AUTOCOMPLETE_PROVIDERS,
	sessionId,
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
	const [pluginCompletion, setPluginCompletion] =
		useState<PluginCompletionState | null>(null);
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
					const store: PromptHistoryStore = promptHistoryStore ?? {
						...getPromptHistoryStore(),
						externalizeAttachments:
							getSessionAttachments().externalizeAttachments,
					};
					const { commandSelections = [], ...storedEntry } = entry;
					const externalization = await store.externalizeAttachments([
						{
							id: "prompt-history",
							parts: entry.files,
							role: "user",
						} as unknown as SessionMessage,
					]);
					try {
						const files = (externalization.messages[0]?.parts ?? []).filter(
							(part): part is PromptHistoryEntry["files"][number] =>
								part.type === "file"
						);
						const durableEntry = { ...storedEntry, files };
						await store.recordPrompt(durableEntry);
						historyRef.current = prependPrompt(historyRef.current, {
							...durableEntry,
							commandSelections,
						});
					} finally {
						await externalization.release();
					}
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
		void (promptHistoryStore ?? getPromptHistoryStore())
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
	const composerCursorOffset = composerDocument.capture().cursorOffset;
	const autocompleteContext = useMemo(
		() =>
			sessionId === undefined
				? undefined
				: createPluginAutocompleteContext(
						textValue,
						composerCursorOffset,
						sessionId
					),
		[composerCursorOffset, sessionId, textValue]
	);
	const autocompleteProvider = useMemo(() => {
		let composedProvider: PluginAutocompleteProvider;
		const baseProvider: PluginAutocompleteProvider = {
			getSuggestions(context) {
				const trigger = detectTrigger(context.text, context.cursorOffset);
				if (
					trigger?.kind !== "file-mention" ||
					composedProvider.shouldTriggerFileCompletion?.(context) === false
				) {
					return null;
				}
				const items = filterFileMentionOptions(
					fileMentionOptions,
					trigger.query
				).map(({ label, path }) => ({ label, value: path }));
				return items.length === 0
					? null
					: { items, prefix: `@${trigger.query}` };
			},
			applyCompletion(context, item, prefix) {
				const trigger = detectTrigger(context.text, context.cursorOffset);
				const fileMention = fileMentionOptions.find(
					({ path }) => path === item.value
				);
				if (trigger?.kind === "file-mention" && fileMention !== undefined) {
					const replacement = applyFileMentionReplacement(
						context.text,
						trigger,
						`@${fileMention.label}`,
						{ addTrailingSpace: fileMention.type !== "directory" }
					);
					return {
						cursorOffset: replacement.cursorOffset,
						text: replacement.text,
					};
				}
				const start = Math.max(0, context.cursorOffset - prefix.length);
				const text = `${context.text.slice(0, start)}${item.value}${context.text.slice(context.cursorOffset)}`;
				return { cursorOffset: start + item.value.length, text };
			},
			shouldTriggerFileCompletion(context) {
				return (
					detectTrigger(context.text, context.cursorOffset)?.kind ===
					"file-mention"
				);
			},
		};
		composedProvider = wrapPluginAutocompleteProviders(
			baseProvider,
			pluginAutocompleteProviders
		);
		return composedProvider;
	}, [fileMentionOptions, pluginAutocompleteProviders]);

	useEffect(() => {
		let active = true;
		setPluginCompletion(null);
		if (
			sessionId === undefined ||
			autocompleteContext === undefined ||
			activeTrigger?.kind === "command"
		) {
			return () => {
				active = false;
			};
		}
		const setAutocompleteCompletion = async (): Promise<void> => {
			if (activeTrigger?.kind !== "file-mention") {
				const argumentCompletion =
					await commandController.getArgumentCompletions(
						textValue,
						composerCursorOffset
					);
				if (!active) {
					return;
				}
				if (argumentCompletion !== null) {
					setSelectedIndex(0);
					setPluginCompletion({
						cursorOffset: composerCursorOffset,
						items: argumentCompletion.items,
						kind: "argument",
						prefix: argumentCompletion.prefix,
						text: textValue,
					});
					return;
				}
			}
			if (pluginAutocompleteProviders.length === 0) {
				return;
			}
			const result =
				await autocompleteProvider.getSuggestions(autocompleteContext);
			if (!active || result === null || result.items.length === 0) {
				return;
			}
			setSelectedIndex(0);
			setPluginCompletion({
				context: autocompleteContext,
				cursorOffset: composerCursorOffset,
				items: result.items,
				kind: "autocomplete",
				prefix: result.prefix,
				provider: autocompleteProvider,
				text: textValue,
			});
		};
		void setAutocompleteCompletion().catch(() => {
			if (active) {
				setPluginCompletion(null);
			}
		});
		return () => {
			active = false;
		};
	}, [
		activeTrigger?.kind,
		autocompleteContext,
		autocompleteProvider,
		commandController,
		composerCursorOffset,
		pluginAutocompleteProviders.length,
		sessionId,
		textValue,
	]);

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

	const currentPluginCompletion =
		pluginCompletion !== null &&
		pluginCompletion.text === textValue &&
		pluginCompletion.cursorOffset === composerCursorOffset
			? pluginCompletion
			: null;
	const visibleOverlayKind = getVisibleOverlayKind(
		currentPluginCompletion,
		overlayKind
	);
	const applyPluginAutocompleteAtIndex = useCallback(
		(index: number): void => {
			if (currentPluginCompletion?.kind !== "autocomplete") {
				return;
			}
			const item = currentPluginCompletion.items[index];
			if (item === undefined) {
				return;
			}
			try {
				const edit = currentPluginCompletion.provider.applyCompletion(
					currentPluginCompletion.context,
					item,
					currentPluginCompletion.prefix
				);
				setProgrammaticText(edit.text, edit.cursorOffset);
				const fileMention = filteredFileMentions.find(
					({ path }) => path === item.value
				);
				if (fileMention?.type === "directory") {
					const nextTrigger = detectTrigger(edit.text, edit.cursorOffset);
					if (nextTrigger?.kind === "file-mention") {
						setActiveTrigger(nextTrigger);
						setOverlayKind("file-mention");
						setSelectedIndex(0);
						return;
					}
				}
			} catch {
				// An autocomplete callback cannot interrupt normal composition.
			}
			closeOverlay();
		},
		[
			closeOverlay,
			currentPluginCompletion,
			filteredFileMentions,
			setProgrammaticText,
		]
	);
	const applyPluginArgumentAtIndex = useCallback(
		(index: number): void => {
			if (currentPluginCompletion?.kind !== "argument") {
				return;
			}
			const item = currentPluginCompletion.items[index];
			if (item === undefined) {
				return;
			}
			const start = Math.max(
				0,
				currentPluginCompletion.cursorOffset -
					currentPluginCompletion.prefix.length
			);
			const text = `${currentPluginCompletion.text.slice(0, start)}${item.value}${currentPluginCompletion.text.slice(currentPluginCompletion.cursorOffset)}`;
			setProgrammaticText(text, start + item.value.length);
			closeOverlay();
		},
		[closeOverlay, currentPluginCompletion, setProgrammaticText]
	);
	const onEnter = useCallback(() => {
		if (disabled) {
			return;
		}

		if (visibleOverlayKind === "command") {
			selectCommandAtIndex(selectedIndex, "enter");
			return;
		}

		if (visibleOverlayKind === "file-mention") {
			executeFileMentionAtIndex(selectedIndex);
			return;
		}

		if (visibleOverlayKind === "plugin-autocomplete") {
			applyPluginAutocompleteAtIndex(selectedIndex);
			return;
		}

		if (visibleOverlayKind === "plugin-argument") {
			applyPluginArgumentAtIndex(selectedIndex);
		}
	}, [
		applyPluginArgumentAtIndex,
		applyPluginAutocompleteAtIndex,
		disabled,
		selectCommandAtIndex,
		executeFileMentionAtIndex,
		visibleOverlayKind,
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
			if (isNull(visibleOverlayKind)) {
				if (isUndefined(cursor)) {
					return false;
				}
				if (decideUpAction(cursor) === "moveToStart") {
					setProgrammaticText(composerDocument.capture().text, 0);
					return true;
				}
				return navigateHistory(-1);
			}

			const itemsLength = getOverlayItemsLength(
				visibleOverlayKind,
				filteredCommands.length,
				filteredFileMentions.length,
				currentPluginCompletion?.items.length ?? 0
			);
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
			currentPluginCompletion,
			filteredCommands.length,
			filteredFileMentions.length,
			navigateHistory,
			visibleOverlayKind,
			setProgrammaticText,
			composerDocument,
		]
	);

	const onArrowDown = useCallback(
		(cursor?: number, length?: number): boolean => {
			if (isNull(visibleOverlayKind)) {
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

			const itemsLength = getOverlayItemsLength(
				visibleOverlayKind,
				filteredCommands.length,
				filteredFileMentions.length,
				currentPluginCompletion?.items.length ?? 0
			);

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
			currentPluginCompletion,
			filteredCommands.length,
			filteredFileMentions.length,
			navigateHistory,
			visibleOverlayKind,
			setProgrammaticText,
			composerDocument,
		]
	);

	const onItemSelect = useCallback(
		(index: number) => {
			if (isNull(visibleOverlayKind)) {
				return;
			}

			setSelectedIndex(index);
		},
		[visibleOverlayKind]
	);

	const onItemExecute = useCallback(
		(index: number) => {
			if (disabled) {
				return;
			}

			if (visibleOverlayKind === "command") {
				selectCommandAtIndex(index, "enter");
				return;
			}

			if (visibleOverlayKind === "file-mention") {
				executeFileMentionAtIndex(index);
				return;
			}

			if (visibleOverlayKind === "plugin-autocomplete") {
				applyPluginAutocompleteAtIndex(index);
				return;
			}

			if (visibleOverlayKind === "plugin-argument") {
				applyPluginArgumentAtIndex(index);
			}
		},
		[
			applyPluginArgumentAtIndex,
			applyPluginAutocompleteAtIndex,
			disabled,
			executeFileMentionAtIndex,
			selectCommandAtIndex,
			visibleOverlayKind,
		]
	);

	const handleTab = useCallback(
		(shift: boolean) => {
			if (disabled) {
				return;
			}

			if (!shift && visibleOverlayKind === "file-mention") {
				executeFileMentionAtIndex(selectedIndex);
				return;
			}

			if (!shift && visibleOverlayKind === "command") {
				selectCommandAtIndex(selectedIndex, "tab");
				return;
			}

			if (!shift && visibleOverlayKind === "plugin-autocomplete") {
				applyPluginAutocompleteAtIndex(selectedIndex);
				return;
			}

			if (!shift && visibleOverlayKind === "plugin-argument") {
				applyPluginArgumentAtIndex(selectedIndex);
				return;
			}

			onTab(shift);
		},
		[
			applyPluginArgumentAtIndex,
			applyPluginAutocompleteAtIndex,
			disabled,
			executeFileMentionAtIndex,
			onTab,
			visibleOverlayKind,
			selectCommandAtIndex,
			selectedIndex,
		]
	);

	let overlay: InputOverlayState = EMPTY_OVERLAY;
	if (visibleOverlayKind === "command") {
		overlay = {
			allItems: commandSuggestions.allItems,
			items: filteredCommands,
			kind: "command",
			selectedIndex,
		};
	} else if (visibleOverlayKind === "file-mention") {
		overlay = {
			items: filteredFileMentions,
			kind: "file-mention",
			selectedIndex,
		};
	} else if (currentPluginCompletion?.kind === "autocomplete") {
		overlay = {
			items: currentPluginCompletion.items,
			kind: "plugin-autocomplete",
			prefix: currentPluginCompletion.prefix,
			selectedIndex,
		};
	} else if (currentPluginCompletion?.kind === "argument") {
		overlay = {
			items: currentPluginCompletion.items,
			kind: "plugin-argument",
			prefix: currentPluginCompletion.prefix,
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
			nextPrompt: () => navigateHistory(1),
			previousPrompt: () => navigateHistory(-1),
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
