import type {
	KeyEvent,
	TextareaOptions,
	TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { RefObject } from "react";

export const CHAT_TEXT_AREA_MIN_HEIGHT = 1;
export const CHAT_TEXT_AREA_MAX_HEIGHT = 6;

export const CHAT_TEXT_AREA_KEY_BINDINGS: NonNullable<
	TextareaOptions["keyBindings"]
> = [
	{ name: "return", action: "submit" },
	{ name: "enter", action: "submit" },
	{ name: "return", shift: true, action: "newline" },
	{ name: "enter", shift: true, action: "newline" },
	{ name: "return", ctrl: true, action: "newline" },
	{ name: "enter", ctrl: true, action: "newline" },
];

type InputKey = Pick<KeyEvent, "ctrl" | "name" | "preventDefault"> & {
	repeated?: boolean;
};

type UseInputKeyboardOptions = {
	disabled: boolean;
	onClear: () => void;
	onCycleMode: () => void;
	textAreaRef: RefObject<Pick<
		TextareaRenderable,
		"clear" | "plainText"
	> | null>;
};

export const hasInputContent = (value: string) => value.length > 0;

export const getInputHeight = (value: string) =>
	Math.min(
		CHAT_TEXT_AREA_MAX_HEIGHT,
		Math.max(CHAT_TEXT_AREA_MIN_HEIGHT, value.split("\n").length)
	);

export const isCtrlC = (key: InputKey) => key.ctrl && key.name === "c";

export const useInputKeyboard = ({
	disabled,
	onClear,
	onCycleMode,
	textAreaRef,
}: UseInputKeyboardOptions) => {
	const renderer = useRenderer();

	useKeyboard((key) => {
		if (isCtrlC(key)) {
			key.preventDefault();

			if (hasInputContent(textAreaRef.current?.plainText ?? "")) {
				textAreaRef.current?.clear();
				onClear();
				return;
			}

			renderer.destroy();
			return;
		}

		if (key.name !== "tab" || key.repeated || disabled) {
			return;
		}

		onCycleMode();
	});
};
