import { isNull, isUndefined } from "@wincode/runtime-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CommandItem,
	createSkillCommandSpecs,
	filterCommandItems,
	getCommandInvocation,
	type SkillCommandSpec,
} from "@/modules/commands/command-item";
import { getVisibleCommands } from "@/modules/commands/commands";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { FileMentionOption } from "@/modules/file-mentions";
import {
	applyFileMentionReplacement,
	filterFileMentionOptions,
} from "@/modules/file-mentions";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/session-operation";
import { useLatest } from "@/shared/hooks/use-latest";
import { normalizeFileTokensForTrimmedText } from "../../attachments";
import { getSessionStore } from "../../storage/get-session-store";
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
	resolveBuiltinCommand,
	type SubmitSnapshot,
	submitPrompt,
} from "./submit";
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
	executeCommand,
	getCustomCommands: getCustomCommandsFromOptions,
	getFileMentionOptions: getFileMentionOptionsFromOptions,
	getSkills: getSkillsFromOptions,
	hideCompact,
	hideVariants,
	onError,
	onSubmit,
	onTab,
	sessionPromptHistory,
	steering = false,
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
	const [skillItems, setSkillItems] = useState<SkillCommandSpec[]>([]);
	const [textSyncRevision, setTextSyncRevision] = useState(0);
	const historyRef = useRef<PromptHistoryEntry[]>([]);
	const historyIndexRef = useRef(-1);
	const draftRef = useRef<PromptHistoryEntry>({ text: "", files: [] });
	const promptRecordQueueRef = useRef(Promise.resolve());
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

		getSkillsFromOptions()
			.then((skills) => {
				if (active) {
					setSkillItems(createSkillCommandSpecs(skills));
				}
			})
			.catch(() => {
				if (active) {
					setSkillItems([]);
				}
			});

		return () => {
			active = false;
		};
	}, [
		getCustomCommandsFromOptions,
		getFileMentionOptionsFromOptions,
		getSkillsFromOptions,
	]);

	const commandQuery =
		activeTrigger?.kind === "command" ? activeTrigger.query : undefined;
	const fileMentionQuery =
		activeTrigger?.kind === "file-mention" ? activeTrigger.query : undefined;
	const commandItems = useMemo(
		() => [
			...getVisibleCommands({ hideCompact, hideVariants }),
			...customCommands,
			...skillItems,
		],
		[customCommands, hideCompact, hideVariants, skillItems]
	);
	const filteredCommands = useMemo(
		() =>
			isUndefined(commandQuery)
				? []
				: filterCommandItems(commandItems, commandQuery),
		[commandItems, commandQuery]
	);
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
			setProgrammaticText(text, 0);
			setRecalledFiles(files);
			setRecalledFileTokens(fileTokens);
			setRecalledFilesRevision((revision) => revision + 1);
			setRecalledPastedTexts(pastedText);
			setRecalledPastedTextsRevision((revision) => revision + 1);
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

			if (command.kind === "custom" || command.kind === "skill") {
				const invocation = `${getCommandInvocation(command)} `;
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
		}
	}, [
		disabled,
		executeCommandAtIndex,
		executeFileMentionAtIndex,
		overlayKind,
		selectedIndex,
	]);

	const onEscape = useCallback(() => {
		if (activeTrigger) {
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

			const command = resolveBuiltinCommand(snapshot);
			const accepted = isNull(command)
				? await submitPrompt(
						{
							disabled,
							discoverCustomCommands: getCustomCommandsFromOptions,
							discoverSkills: getSkillsFromOptions,
							onError,
							onSubmit: onSubmitRef.current,
							steering,
						},
						snapshot
					)
				: true;
			if (!accepted) {
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
			setProgrammaticText("", null);
			closeOverlay();
			if (!isNull(command)) {
				await executeCommand(command);
			}
			return true;
		},
		[
			closeOverlay,
			disabled,
			executeCommand,
			getCustomCommandsFromOptions,
			getSkillsFromOptions,
			onError,
			rememberPrompt,
			resetHistoryBaseline,
			setProgrammaticText,
			steering,
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
				executeCommandAtIndex(index);
				return;
			}

			if (overlayKind === "file-mention") {
				executeFileMentionAtIndex(index);
			}
		},
		[disabled, executeCommandAtIndex, executeFileMentionAtIndex, overlayKind]
	);

	const handleTab = useCallback(
		(shift: boolean) => {
			if (disabled || steering) {
				return;
			}

			onTab(shift);
		},
		[disabled, onTab, steering]
	);

	let overlay: InputOverlayState = EMPTY_OVERLAY;
	if (overlayKind === "command") {
		overlay = {
			allItems: commandItems,
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
