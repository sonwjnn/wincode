import { useKeyboard, useRenderer } from "@opentui/react";
import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

type Responder = () => boolean;
export type ToggleShortcut = "ctrl+o";
export type ToggleHandler = () => void;
type ToggleKeyEvent = {
	ctrl: boolean;
	name: string;
	preventDefault: () => void;
};

type KeyboardLayerContextValue = {
	push: (id: string, responder?: Responder) => void;
	pop: (id: string) => void;
	isTopLayer: (id: string) => boolean;
	setResponder: (id: string, responder: Responder | null) => void;
	registerToggle: (
		shortcut: ToggleShortcut,
		toggle: ToggleHandler
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
	const stackRef = useRef(stack);
	stackRef.current = stack;

	const responders = useRef<Map<string, Responder>>(new Map());
	const toggleHandlers = useRef(new Map<ToggleShortcut, Set<ToggleHandler>>());
	const renderer = useRenderer();

	const push = useCallback((id: string, responder?: Responder) => {
		if (responder) {
			responders.current.set(id, responder);
		}

		setStack((prev) => {
			if (prev.includes(id)) {
				return prev;
			}

			return [...prev, id];
		});
	}, []);

	const pop = useCallback((id: string) => {
		responders.current.delete(id);
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
	const handleToggleShortcut = useCallback((key: ToggleKeyEvent): boolean => {
		if (!key.ctrl || key.name !== "o") {
			return false;
		}

		const currentStack = stackRef.current;
		if (currentStack.length !== 0 && currentStack.at(-1) !== "base") {
			return true;
		}

		key.preventDefault();
		for (const toggle of toggleHandlers.current.get("ctrl+o") ?? []) {
			toggle();
		}
		return true;
	}, []);

	useKeyboard((key) => {
		if (handleToggleShortcut(key)) {
			return;
		}

		// Single ctrl+c handler that walks the responder chain.
		if (!key.ctrl || key.name !== "c") {
			return;
		}

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
			value={{ push, pop, isTopLayer, registerToggle, setResponder }}
		>
			{children}
		</KeyboardLayerContext.Provider>
	);
}

export function useKeyboardLayer() {
	const context = useContext(KeyboardLayerContext);
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
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;

	useEffect(() => {
		if (!enabled) {
			return;
		}
		return registerToggle(shortcut, () => toggleRef.current());
	}, [enabled, registerToggle, shortcut]);
}
