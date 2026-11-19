import { expect, test } from "bun:test";
import { parseKeyboardShortcut } from "@/shared/providers/keyboard-layer/shortcut";

test("shortcut parsing rejects modifier names in the key position", () => {
	for (const key of ["alt", "ctrl", "meta", "shift"]) {
		expect(parseKeyboardShortcut(key)).toBeUndefined();
		expect(parseKeyboardShortcut(`ctrl+${key}`)).toBeUndefined();
	}

	expect(parseKeyboardShortcut("ctrl+shift+p")).toEqual({
		alt: false,
		ctrl: true,
		key: "p",
		meta: false,
		shift: true,
	});
});
