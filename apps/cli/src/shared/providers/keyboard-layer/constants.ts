import type { TextareaOptions } from "@opentui/core";
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
