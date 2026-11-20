import {
	DialogFrame,
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@wincode/tui";
import { RGBA, TextAttributes } from "@wincode/tui/core";
import { isUndefined } from "@wincode/utils";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useKeyboardLayer } from "../keyboard-layer/keyboard-layer-provider";
import { useTheme } from "../theme/theme-provider";
import {
	DEFAULT_DIALOG_CONTENT_MARGIN,
	DEFAULT_DIALOG_PADDING,
} from "./defaults";
import type { DialogConfig, DialogPadding } from "./types";

export type DialogContextValue = {
	open: (config: DialogConfig) => void;
	close: (layerId?: string) => void;
	closeAll: () => void;
};

const DialogContext = createContext<DialogContextValue | null>(null);
const DialogLayerContext = createContext<string>("dialog");

export function useDialog(): DialogContextValue {
	const value = useContext(DialogContext);
	if (!value) {
		throw new Error("useDialog must be used within a DialogProvider");
	}
	return value;
}

export function useDialogLayer(): string {
	return useContext(DialogLayerContext);
}

export function useDialogEscape(layerId?: string, enabled = true): void {
	const dialog = useDialog();
	const { isTopLayer } = useKeyboardLayer();
	const dialogLayerId = useDialogLayer();
	const resolvedLayerId = layerId ?? dialogLayerId;

	useKeyboard((key) => {
		if (!(enabled && isTopLayer(resolvedLayerId))) {
			return;
		}
		if (key.name === "escape") {
			dialog.close();
		}
	});
}

type DialogProviderProps = {
	children: ReactNode;
};

export function DialogProvider({ children }: DialogProviderProps) {
	const [dialogStack, setDialogStack] = useState<DialogConfig[]>([]);
	const dialogStackRef = useRef<DialogConfig[]>([]);
	const layerIdsRef = useRef<string[]>([]);
	const counter = useRef(0);
	const { push, pop } = useKeyboardLayer();
	const baseLayerId = useId();

	const updateStack = useCallback(
		(updater: (prev: DialogConfig[]) => DialogConfig[]) => {
			setDialogStack((prev) => {
				const next = updater(prev);
				dialogStackRef.current = next;
				layerIdsRef.current = next.map((d) => d.layerId ?? "");
				return next;
			});
		},
		[]
	);

	const close = useCallback(
		(layerId?: string) => {
			const targetId = layerId ?? layerIdsRef.current.at(-1);
			if (targetId === undefined) {
				return;
			}
			pop(targetId);
			updateStack((prev) =>
				prev.filter((dialog) => dialog.layerId !== targetId)
			);
		},
		[pop, updateStack]
	);

	const closeAll = useCallback(() => {
		const currentStack = dialogStackRef.current;
		if (currentStack.length === 0) {
			return;
		}

		layerIdsRef.current = [];
		dialogStackRef.current = [];
		setDialogStack([]);

		for (let index = currentStack.length - 1; index >= 0; index -= 1) {
			const layerId = currentStack[index]?.layerId;
			if (layerId) {
				pop(layerId);
			}
		}
	}, [pop]);

	const open = useCallback(
		(config: DialogConfig) => {
			const layerId = config.layerId ?? `${baseLayerId}-${counter.current++}`;
			const configWithLayer = { ...config, layerId };
			updateStack((prev) => [...prev, configWithLayer]);
			push(layerId, () => {
				close(layerId);
				return true;
			});
		},
		[push, baseLayerId, updateStack, close]
	);

	const value: DialogContextValue = {
		open,
		close,
		closeAll,
	};

	return (
		<DialogContext.Provider value={value}>
			{children}
			{dialogStack.map((dialog, index) => (
				<Dialog
					close={close}
					config={dialog}
					isTop={index === dialogStack.length - 1}
					key={dialog.layerId}
					zIndex={100 + index}
				/>
			))}
		</DialogContext.Provider>
	);
}

type DialogProps = {
	config: DialogConfig;
	close: () => void;
	isTop: boolean;
	zIndex: number;
};

function resolvePadding(
	defaults: Required<DialogPadding>,
	overrides: DialogPadding | undefined
): Required<DialogPadding> {
	return {
		bottom: overrides?.bottom ?? defaults.bottom,
		left: overrides?.left ?? defaults.left,
		right: overrides?.right ?? defaults.right,
		top: overrides?.top ?? defaults.top,
	};
}

function Dialog({ config, close, isTop, zIndex }: DialogProps) {
	const dimensions = useTerminalDimensions();
	const renderer = useRenderer();
	const previousFocusedRenderable = useRef(
		config.restoreFocus ? renderer.currentFocusedRenderable : null
	);
	const restoreFocusRef = useRef(config.restoreFocus === true);
	const isTopRef = useRef(isTop);
	isTopRef.current = isTop;
	const { colors } = useTheme();

	const layerId = config.layerId ?? "";

	useLayoutEffect(
		() => () => {
			if (!(restoreFocusRef.current && isTopRef.current)) {
				return;
			}
			const previous = previousFocusedRenderable.current;
			if (previous && !previous.isDestroyed) {
				previous.focus();
			}
		},
		[]
	);

	const { title, children, padding } = config;
	const resolvedPadding = resolvePadding(DEFAULT_DIALOG_PADDING, padding);
	const defaultWidth =
		dimensions.width >= 120
			? Math.floor(dimensions.width * 0.67)
			: Math.min(100, dimensions.width - 2);
	const maxWidth = Math.max(1, dimensions.width - 2);
	const width = isUndefined(config.width)
		? defaultWidth
		: Math.max(1, Math.min(config.width, maxWidth));

	return (
		<DialogFrame
			active={isTop}
			backdropColor={isTop ? RGBA.fromInts(0, 0, 0, 150) : undefined}
			backgroundColor={colors.backgroundElement}
			onBackdropClick={isTop ? () => close() : undefined}
			padding={resolvedPadding}
			width={width}
			zIndex={zIndex}
		>
			<box flexDirection="column" gap={1}>
				<box
					alignItems="center"
					flexDirection="row"
					justifyContent="space-between"
					marginX={DEFAULT_DIALOG_CONTENT_MARGIN.left}
				>
					<text attributes={TextAttributes.BOLD} fg={colors.text}>
						{title}
					</text>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
					<text fg={colors.textMuted} onMouseDown={() => close()}>
						esc
					</text>
				</box>
				<DialogLayerContext.Provider value={layerId}>
					<box flexGrow={1}>{children}</box>
				</DialogLayerContext.Provider>
			</box>
		</DialogFrame>
	);
}
