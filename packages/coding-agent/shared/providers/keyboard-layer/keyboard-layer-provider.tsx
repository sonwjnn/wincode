import { useKeyboard, useRenderer } from "@opentui/react";
import { isUndefined, logger } from "@wincode/utils";
import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useLatest } from "@/shared/hooks/use-latest";
import {
	formatKeyboardShortcut,
	type KeyboardShortcut,
	matchesKeyboardShortcut,
	parseKeyboardShortcut,
} from "./shortcut";

type Responder = () => boolean;
type ShortcutRegistration = Readonly<{
	handler: () => void;
	ownerId: string;
	shortcut: KeyboardShortcut;
}>;
type TerminalInputRegistration = Readonly<{
	handler: (data: string) => boolean;
	ownerId: string;
}>;
export type ToggleShortcut = "ctrl+o";
export type ToggleHandler = () => void;
type ToggleKeyEvent = {
	ctrl: boolean;
	defaultPrevented: boolean;
	meta: boolean;
	name: string;
	option: boolean;
	preventDefault: () => void;
	shift: boolean;
};

const KITTY_KEY_SEQUENCE_PATTERN = /^(\d+);(\d+)(?::\d+)?u$/u;

const isReservedTerminalInput = (sequence: string): boolean => {
	if (
		sequence === "\u001b" ||
		sequence === "\u0003" ||
		sequence === "\u001b[27u"
	) {
		return true;
	}
	if (!sequence.startsWith("\u001b[")) {
		return false;
	}
	const kittyKey = KITTY_KEY_SEQUENCE_PATTERN.exec(sequence.slice(2));
	if (kittyKey === null) {
		return false;
	}
	const keyCode = Number(kittyKey[1]);
	const modifierCode = Number(kittyKey[2]);
	const hasControl = Math.floor((modifierCode - 1) / 4) % 2 === 1;
	return keyCode === 27 || (hasControl && (keyCode === 67 || keyCode === 99));
};

const findMatchingPluginShortcuts = (
	registrationsByShortcut: ReadonlyMap<string, readonly ShortcutRegistration[]>,
	key: ToggleKeyEvent
): readonly ShortcutRegistration[] => {
	const shortcut = parseKeyboardShortcut(
		[
			...(key.ctrl ? ["ctrl"] : []),
			...(key.option ? ["alt"] : []),
			...(key.shift ? ["shift"] : []),
			...(key.meta ? ["meta"] : []),
			key.name,
		].join("+")
	);
	if (shortcut === undefined) {
		return [];
	}
	const registrations = registrationsByShortcut.get(
		formatKeyboardShortcut(shortcut)
	);
	return (
		registrations?.filter((registration) =>
			matchesKeyboardShortcut(registration.shortcut, key)
		) ?? []
	);
};

const invokePluginShortcuts = (
	registrations: readonly ShortcutRegistration[]
): void => {
	for (const registration of registrations) {
		try {
			registration.handler();
		} catch (error) {
			void logger
				.error("Plugin keyboard shortcut failed", {
					cause: error instanceof Error ? error.message : String(error),
					ownerId: registration.ownerId,
				})
				.catch(() => undefined);
		}
	}
};

const dispatchTerminalInput = (
	sequence: string,
	registrationsByOwner: ReadonlyMap<
		string,
		readonly TerminalInputRegistration[]
	>
): boolean => {
	if (isReservedTerminalInput(sequence)) {
		return false;
	}
	for (const registrations of registrationsByOwner.values()) {
		for (const registration of [...registrations]) {
			try {
				if (registration.handler(sequence)) {
					return true;
				}
			} catch (error) {
				void logger
					.error("Plugin terminal input handler failed", {
						cause: error instanceof Error ? error.message : String(error),
						ownerId: registration.ownerId,
					})
					.catch(() => undefined);
			}
		}
	}
	return false;
};

export type KeyboardLayerContextValue = {
	push: (
		id: string,
		responder?: Responder,
		escapeResponder?: Responder
	) => void;
	pop: (id: string) => void;
	isTopLayer: (id: string) => boolean;
	setResponder: (id: string, responder: Responder | null) => void;
	registerToggle: (
		shortcut: ToggleShortcut,
		toggle: ToggleHandler
	) => () => void;
	registerShortcut: (
		ownerId: string,
		shortcut: string,
		handler: () => void
	) => () => void;
	registerTerminalInput: (
		ownerId: string,
		handler: (data: string) => boolean
	) => () => void;
};

const KeyboardLayerContext = createContext<KeyboardLayerContextValue | null>(
	null
);

export function KeyboardLayerProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [stack, setStack] = useState<string[]>(["base"]);
	const stackRef = useLatest(stack);

	const responders = useRef<Map<string, Responder>>(new Map());
	const escapeResponders = useRef<Map<string, Responder>>(new Map());
	const toggleHandlers = useRef(new Map<ToggleShortcut, Set<ToggleHandler>>());
	const shortcutHandlers = useRef(new Map<string, ShortcutRegistration[]>());
	const terminalInputHandlers = useRef(
		new Map<string, TerminalInputRegistration[]>()
	);
	const renderer = useRenderer();

	const push = useCallback(
		(id: string, responder?: Responder, escapeResponder?: Responder) => {
			if (responder) {
				responders.current.set(id, responder);
			}
			if (escapeResponder) {
				escapeResponders.current.set(id, escapeResponder);
			}

			setStack((prev) => {
				if (prev.includes(id)) {
					return prev;
				}

				return [...prev, id];
			});
		},
		[]
	);

	const pop = useCallback((id: string) => {
		responders.current.delete(id);
		escapeResponders.current.delete(id);
		setStack((prev) => prev.filter((layer) => layer !== id));
	}, []);

	const isTopLayer = useCallback(
		(id: string) => stack.length === 0 || stack.at(-1) === id,
		[stack]
	);

	const setResponder = useCallback(
		(id: string, responder: Responder | null) => {
			if (responder) {
				responders.current.set(id, responder);
			} else {
				responders.current.delete(id);
			}
		},
		[]
	);

	const registerShortcut = useCallback(
		(ownerId: string, shortcut: string, handler: () => void) => {
			const parsedShortcut = parseKeyboardShortcut(shortcut);
			if (parsedShortcut === undefined) {
				throw new Error(`Invalid Plugin shortcut '${shortcut}'.`);
			}
			const key = formatKeyboardShortcut(parsedShortcut);
			const registrations = shortcutHandlers.current.get(key) ?? [];
			const registration = Object.freeze({
				handler,
				ownerId,
				shortcut: parsedShortcut,
			});
			registrations.push(registration);
			shortcutHandlers.current.set(key, registrations);
			return () => {
				const current = shortcutHandlers.current.get(key);
				if (current === undefined) {
					return;
				}
				const index = current.indexOf(registration);
				if (index !== -1) {
					current.splice(index, 1);
				}
				if (current.length === 0) {
					shortcutHandlers.current.delete(key);
				}
			};
		},
		[]
	);

	const registerTerminalInput = useCallback(
		(ownerId: string, handler: (data: string) => boolean) => {
			const registrations = terminalInputHandlers.current.get(ownerId) ?? [];
			const registration = Object.freeze({ handler, ownerId });
			registrations.push(registration);
			terminalInputHandlers.current.set(ownerId, registrations);
			return () => {
				const current = terminalInputHandlers.current.get(ownerId);
				if (current === undefined) {
					return;
				}
				const index = current.indexOf(registration);
				if (index !== -1) {
					current.splice(index, 1);
				}
				if (current.length === 0) {
					terminalInputHandlers.current.delete(ownerId);
				}
			};
		},
		[]
	);

	const registerToggle = useCallback(
		(shortcut: ToggleShortcut, toggle: ToggleHandler) => {
			const handlers =
				toggleHandlers.current.get(shortcut) ?? new Set<ToggleHandler>();
			handlers.add(toggle);
			toggleHandlers.current.set(shortcut, handlers);
			return () => {
				handlers.delete(toggle);
				if (handlers.size === 0) {
					toggleHandlers.current.delete(shortcut);
				}
			};
		},
		[]
	);
	const handleEscapeShortcut = useCallback((key: ToggleKeyEvent): boolean => {
		if (key.name !== "escape") {
			return false;
		}
		const topLayer = stackRef.current.at(-1);
		if (topLayer === undefined || !escapeResponders.current.get(topLayer)?.()) {
			return false;
		}
		key.preventDefault();
		return true;
	}, []);

	const handleToggleShortcut = useCallback((key: ToggleKeyEvent): boolean => {
		if (!key.ctrl) {
			return false;
		}
		const shortcut = `ctrl+${key.name}` as ToggleShortcut;
		const handlers = toggleHandlers.current.get(shortcut);
		if (isUndefined(handlers) || handlers.size === 0) {
			return false;
		}

		const currentStack = stackRef.current;
		if (
			shortcut === "ctrl+o" &&
			currentStack.length !== 0 &&
			currentStack.at(-1) !== "base"
		) {
			return true;
		}

		key.preventDefault();
		for (const toggle of handlers) {
			toggle();
		}
		return true;
	}, []);

	const handlePluginShortcut = useCallback((key: ToggleKeyEvent) => {
		// Host and focused local handlers keep precedence when they claim a key.
		if (key.defaultPrevented || stackRef.current.at(-1) !== "base") {
			return false;
		}
		const matching = findMatchingPluginShortcuts(shortcutHandlers.current, key);
		if (matching.length === 0) {
			return false;
		}
		key.preventDefault();
		invokePluginShortcuts(matching);
		return true;
	}, []);

	useEffect(() => {
		const inputHandler = (sequence: string): boolean =>
			dispatchTerminalInput(sequence, terminalInputHandlers.current);
		renderer.addInputHandler(inputHandler);
		return () => renderer.removeInputHandler(inputHandler);
	}, [renderer]);

	useKeyboard((key) => {
		if (handleEscapeShortcut(key)) {
			return;
		}
		if (handleToggleShortcut(key)) {
			return;
		}
		// Single ctrl+c handler that walks the responder chain.
		if (!key.ctrl || key.name !== "c") {
			if (handlePluginShortcut(key)) {
				return;
			}
			return;
		}
		key.preventDefault();

		const currentStack = stackRef.current;
		for (let i = currentStack.length - 1; i >= 0; i -= 1) {
			const layerId = currentStack[i];
			if (!layerId) {
				continue;
			}

			const responder = responders.current.get(layerId);
			if (responder?.()) {
				return;
			}
		}

		// No responder handled it — exit
		renderer.destroy();
	});

	return (
		<KeyboardLayerContext.Provider
			value={{
				push,
				pop,
				isTopLayer,
				registerToggle,
				registerShortcut,
				registerTerminalInput,
				setResponder,
			}}
		>
			{children}
		</KeyboardLayerContext.Provider>
	);
}

/** Read the layer context when a provider is mounted, else `null`. */
export const useOptionalKeyboardLayer = (): KeyboardLayerContextValue | null =>
	useContext(KeyboardLayerContext);

export function useKeyboardLayer() {
	const context = useOptionalKeyboardLayer();
	if (!context) {
		throw new Error(
			"useKeyboardLayer must be used within a KeyboardLayerProvider"
		);
	}
	return context;
}
export function useToggleShortcut(
	shortcut: ToggleShortcut,
	toggle: ToggleHandler,
	enabled = true
) {
	const { registerToggle } = useKeyboardLayer();
	const toggleRef = useLatest(toggle);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		return registerToggle(shortcut, () => toggleRef.current());
	}, [enabled, registerToggle, shortcut]);
}
