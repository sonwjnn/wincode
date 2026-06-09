import { useCallback, useMemo, useRef, useState } from "react";
import type { CommandSpec } from "../../command-menu/commands";
import { getFilteredCommands } from "../../command-menu/filter-commands";
import { detectTrigger } from "./triggers";
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
	onSubmit,
	onTab,
}: ChatInputControllerOptions): ChatInputController {
	const [textValue, setTextValue] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [overlayKind, setOverlayKind] =
		useState<InputOverlayState["kind"]>(null);
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;

	const trigger = detectTrigger(textValue, 0);
	const commandQuery = trigger?.kind === "command" ? trigger.query : undefined;
	const filteredCommands = useMemo(
		() => (commandQuery === undefined ? [] : getFilteredCommands(commandQuery)),
		[commandQuery]
	);

	const closeOverlay = useCallback(() => {
		setOverlayKind(null);
		setSelectedIndex(0);
	}, []);

	const onTextChange = useCallback((text: string, cursorOffset: number) => {
		setTextValue(text);
		setSelectedIndex(0);

		const nextTrigger = detectTrigger(text, cursorOffset);
		setOverlayKind(nextTrigger?.kind === "command" ? "command" : null);
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
			setTextValue("");
			closeOverlay();
		},
		[closeOverlay, executeCommand, resolveCommand]
	);

	const onEnter = useCallback(() => {
		if (disabled) {
			return;
		}

		if (overlayKind === "command") {
			executeCommandAtIndex(selectedIndex);
			return;
		}

		const text = textValue.trim();
		if (text.length === 0) {
			return;
		}

		onSubmitRef.current(text);
		setTextValue("");
		closeOverlay();
	}, [
		closeOverlay,
		disabled,
		executeCommandAtIndex,
		overlayKind,
		selectedIndex,
		textValue,
	]);

	const onEscape = useCallback(() => {
		closeOverlay();
	}, [closeOverlay]);

	const onCtrlC = useCallback(() => {
		if (disabled || (textValue.length === 0 && overlayKind === null)) {
			return false;
		}

		setTextValue("");
		closeOverlay();
		return true;
	}, [closeOverlay, disabled, overlayKind, textValue.length]);

	const onArrowUp = useCallback(() => {
		if (overlayKind !== "command") {
			return;
		}

		setSelectedIndex((index) => Math.max(0, index - 1));
	}, [overlayKind]);

	const onArrowDown = useCallback(() => {
		if (overlayKind !== "command" || filteredCommands.length === 0) {
			return;
		}

		setSelectedIndex((index) =>
			Math.min(filteredCommands.length - 1, index + 1)
		);
	}, [filteredCommands.length, overlayKind]);

	const onItemSelect = useCallback(
		(index: number) => {
			if (overlayKind !== "command") {
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

			executeCommandAtIndex(index);
		},
		[disabled, executeCommandAtIndex]
	);

	const handleTab = useCallback(() => {
		if (disabled) {
			return;
		}

		onTab();
	}, [disabled, onTab]);

	const overlay: InputOverlayState =
		overlayKind === "command"
			? { items: filteredCommands, kind: "command", selectedIndex }
			: EMPTY_OVERLAY;

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
			overlay,
			text: textValue,
		},
	};
}
