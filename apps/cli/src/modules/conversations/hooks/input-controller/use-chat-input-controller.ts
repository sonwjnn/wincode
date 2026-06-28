import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandSpec } from "@/modules/commands/commands";
import { getFilteredCommands } from "@/modules/commands/filter-commands";
import { applyFileMentionReplacement } from "../../utils/file-mentions/mention-grammar";
import { filterFileMentionOptions } from "./file-mention-options";
import { type ActiveTrigger, detectTrigger } from "./triggers";
import type {
	ChatInputController,
	ChatInputControllerOptions,
	FileMentionOption,
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
	getFileMentionOptions: getFileMentionOptionsFromOptions,
	onSubmit,
	onTab,
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
	const [textSyncRevision, setTextSyncRevision] = useState(0);
	const [visibleStartIndex, setVisibleStartIndex] = useState(0);
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
	const filteredCommands = useMemo(
		() => (commandQuery === undefined ? [] : getFilteredCommands(commandQuery)),
		[commandQuery]
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

	const onTextChange = useCallback((text: string, cursorOffset: number) => {
		setTextValue(text);
		setCursorOffset(null);
		setSelectedIndex(0);
		setVisibleStartIndex(0);

		const nextTrigger = detectTrigger(text, cursorOffset);
		setActiveTrigger(nextTrigger);
		setOverlayKind(nextTrigger?.kind ?? null);
	}, []);

	const resolveCommand = useCallback(
		(index: number): CommandSpec | undefined => {
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

			executeCommand(command);
			setProgrammaticText("", null);
			closeOverlay();
		},
		[closeOverlay, executeCommand, resolveCommand, setProgrammaticText]
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
	]);

	const onEscape = useCallback(() => {
		closeOverlay();
	}, [closeOverlay]);

	const onCtrlC = useCallback(() => {
		if (disabled || (textValue.length === 0 && overlayKind === null)) {
			return false;
		}

		setProgrammaticText("", null);
		closeOverlay();
		return true;
	}, [
		closeOverlay,
		disabled,
		overlayKind,
		setProgrammaticText,
		textValue.length,
	]);

	const onArrowUp = useCallback(() => {
		if (overlayKind === null) {
			return;
		}

		const nextIndex = Math.max(0, selectedIndexRef.current - 1);
		setSelectedIndex(nextIndex);
		setVisibleStartIndex((start) =>
			nextIndex < start ? Math.max(0, nextIndex) : start
		);
	}, [overlayKind]);

	const onArrowDown = useCallback(() => {
		if (overlayKind === null) {
			return;
		}

		const itemsLength =
			overlayKind === "command"
				? filteredCommands.length
				: filteredFileMentions.length;

		if (itemsLength === 0) {
			return;
		}

		const nextIndex = Math.min(itemsLength - 1, selectedIndexRef.current + 1);
		setSelectedIndex(nextIndex);
		setVisibleStartIndex((start) =>
			nextIndex >= start + MAX_VISIBLE_ITEMS
				? nextIndex - MAX_VISIBLE_ITEMS + 1
				: start
		);
	}, [filteredCommands.length, filteredFileMentions.length, overlayKind]);

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
			onCtrlC,
			onEnter,
			onEscape,
			onItemExecute,
			onItemSelect,
			onTab: handleTab,
			onTextChange,
		},
		state: {
			cursorOffset,
			overlay,
			text: textValue,
			textSyncRevision,
			visibleStartIndex,
		},
	};
}
