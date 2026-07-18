import type { BoxRenderable } from "@opentui/core";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useKeyboardLayer } from "../keyboard-layer/keyboard-layer-provider";
import { useTheme } from "../theme/theme-provider";
import type { DialogConfig } from "./types";

export type DialogContextValue = {
	open: (config: DialogConfig) => void;
	close: () => void;
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

export function useDialogEscape(layerId?: string): void {
	const dialog = useDialog();
	const { isTopLayer } = useKeyboardLayer();
	const dialogLayerId = useDialogLayer();
	const resolvedLayerId = layerId ?? dialogLayerId;

	useKeyboard((key) => {
		if (!isTopLayer(resolvedLayerId)) {
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

	const close = useCallback(() => {
		const topId = layerIdsRef.current.at(-1);
		if (!topId) {
			return;
		}
		pop(topId);
		updateStack((prev) => prev.slice(0, -1));
	}, [pop, updateStack]);

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
				pop(layerId);
				updateStack((prev) => {
					const idx = prev.findIndex((d) => d.layerId === layerId);
					if (idx === -1) {
						return prev;
					}
					return prev.slice(0, idx);
				});
				return true;
			});
		},
		[push, baseLayerId, updateStack, pop]
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

function Dialog({ config, close, isTop, zIndex }: DialogProps) {
	const dimensions = useTerminalDimensions();
	const { colors } = useTheme();
	const dialogRef = useRef<BoxRenderable>(null);
	const initialHeightRef = useRef<number | null>(null);
	const [anchoredTop, setAnchoredTop] = useState<number | null>(null);

	const layerId = config.layerId ?? "";

	const { title, children, padding, titleMargin } = config;
	const padLeft = padding?.left ?? 4;
	const padRight = padding?.right ?? 4;
	const padTop = padding?.top ?? 1;
	const padBottom = padding?.bottom ?? 1;
	const titleMarLeft = titleMargin?.left ?? 0;
	const titleMarRight = titleMargin?.right ?? 0;
	const titleMarTop = titleMargin?.top ?? 0;
	const titleMarBottom = titleMargin?.bottom ?? 0;
	const backdropColor = isTop ? RGBA.fromInts(0, 0, 0, 150) : undefined;

	const defaultWidth =
		dimensions.width >= 120
			? Math.floor(dimensions.width * 0.67)
			: Math.min(100, dimensions.width - 2);
	const maxWidth = Math.max(1, dimensions.width - 2);
	const width =
		config.width === undefined
			? defaultWidth
			: Math.max(1, Math.min(config.width, maxWidth));

	useLayoutEffect(() => {
		const dialogHeight = initialHeightRef.current ?? dialogRef.current?.height;
		if (!(dialogHeight && dialogHeight > 0)) {
			return;
		}

		initialHeightRef.current = dialogHeight;
		setAnchoredTop(
			Math.max(0, Math.floor((dimensions.height - dialogHeight) / 2))
		);
	}, [dimensions.height]);

	useEffect(() => {
		if (anchoredTop !== null) {
			return;
		}
		const dialogHeight = dialogRef.current?.height;
		if (!(dialogHeight && dialogHeight > 0)) {
			return;
		}

		initialHeightRef.current = dialogHeight;
		setAnchoredTop(
			Math.max(0, Math.floor((dimensions.height - dialogHeight) / 2))
		);
	}, [anchoredTop, dimensions.height]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			alignItems="center"
			backgroundColor={backdropColor}
			height={dimensions.height}
			justifyContent="center"
			left={0}
			onMouseDown={isTop ? () => close() : undefined}
			position="absolute"
			top={0}
			width={dimensions.width}
			zIndex={zIndex}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events. */}
			<box
				backgroundColor={colors.dialogSurface}
				flexDirection="column"
				gap={1}
				height="auto"
				onMouseDown={(e) => e.stopPropagation()}
				paddingBottom={padBottom}
				paddingLeft={padLeft}
				paddingRight={padRight}
				paddingTop={padTop}
				position={anchoredTop === null ? "relative" : "absolute"}
				ref={dialogRef}
				top={anchoredTop ?? undefined}
				width={width}
			>
				<box
					alignItems="center"
					flexDirection="row"
					justifyContent="space-between"
					marginBottom={titleMarBottom}
					marginLeft={titleMarLeft}
					marginRight={titleMarRight}
					marginTop={titleMarTop}
				>
					<text attributes={TextAttributes.BOLD}>{title}</text>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
					<text attributes={TextAttributes.DIM} onMouseDown={() => close()}>
						esc
					</text>
				</box>
				<DialogLayerContext.Provider value={layerId}>
					<box flexGrow={1}>{children}</box>
				</DialogLayerContext.Provider>
			</box>
		</box>
	);
}
