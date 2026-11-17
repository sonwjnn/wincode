export type KeyboardShortcut = Readonly<{
	alt: boolean;
	ctrl: boolean;
	key: string;
	meta: boolean;
	shift: boolean;
}>;

export type KeyboardShortcutEvent = Readonly<{
	ctrl: boolean;
	meta: boolean;
	name: string;
	option: boolean;
	shift: boolean;
}>;

const MODIFIERS = new Set(["alt", "ctrl", "meta", "shift"]);
const KEY_NAME = /^[a-z0-9][a-z0-9-]*$/u;

/** Parses the shared `modifier+key` spelling without loading the Interactive UI. */
export const parseKeyboardShortcut = (
	shortcut: string
): KeyboardShortcut | undefined => {
	const parts = shortcut.trim().toLowerCase().split("+");
	const key = parts.pop();
	if (key === undefined || !KEY_NAME.test(key)) {
		return;
	}
	const modifiers = new Set<string>();
	for (const modifier of parts) {
		if (!MODIFIERS.has(modifier) || modifiers.has(modifier)) {
			return;
		}
		modifiers.add(modifier);
	}
	return Object.freeze({
		alt: modifiers.has("alt"),
		ctrl: modifiers.has("ctrl"),
		key,
		meta: modifiers.has("meta"),
		shift: modifiers.has("shift"),
	});
};

export const formatKeyboardShortcut = (shortcut: KeyboardShortcut): string =>
	[
		...(shortcut.ctrl ? ["ctrl"] : []),
		...(shortcut.alt ? ["alt"] : []),
		...(shortcut.shift ? ["shift"] : []),
		...(shortcut.meta ? ["meta"] : []),
		shortcut.key,
	].join("+");

export const matchesKeyboardShortcut = (
	shortcut: KeyboardShortcut,
	event: KeyboardShortcutEvent
): boolean =>
	event.name.toLowerCase() === shortcut.key &&
	event.ctrl === shortcut.ctrl &&
	event.option === shortcut.alt &&
	event.shift === shortcut.shift &&
	event.meta === shortcut.meta;
