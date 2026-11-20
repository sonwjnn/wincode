import type { BoxRenderable, RGBA } from "@opentui/core";
import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "./react-hooks";

export type DialogFramePadding = Readonly<{
	bottom?: number;
	left?: number;
	right?: number;
	top?: number;
}>;

export type DialogFrameProps = Readonly<{
	active?: boolean;
	backgroundColor: string | RGBA;
	backdropColor?: string | RGBA;
	border?: boolean;
	children: ReactNode;
	maxHeight?: number;
	onBackdropClick?: () => void;
	padding?: number | DialogFramePadding;
	width?: number;
	zIndex?: number;
}>;

/** Centers and bounds dialog content without taking ownership of modal policy. */
export function DialogFrame({
	active = true,
	backgroundColor,
	backdropColor,
	border = false,
	children,
	maxHeight,
	onBackdropClick,
	padding = 1,
	width,
	zIndex = 100,
}: DialogFrameProps) {
	const dimensions = useTerminalDimensions();
	const frameRef = useRef<BoxRenderable>(null);
	const measuredHeightRef = useRef(0);
	const [measuredHeight, setMeasuredHeight] = useState(0);
	const resolvedWidth = Math.max(
		1,
		Math.min(width ?? 56, Math.max(1, dimensions.width - 2))
	);
	const resolvedMaxHeight = Math.max(
		1,
		Math.min(maxHeight ?? dimensions.height, dimensions.height)
	);
	const paddingValues =
		typeof padding === "number"
			? {
					bottom: padding,
					left: padding,
					right: padding,
					top: padding,
				}
			: {
					bottom: padding.bottom ?? 1,
					left: padding.left ?? 1,
					right: padding.right ?? 1,
					top: padding.top ?? 1,
				};
	const updateMeasuredHeight = useCallback(() => {
		const nextHeight = frameRef.current?.height ?? 0;
		if (nextHeight <= 0 || measuredHeightRef.current === nextHeight) {
			return;
		}
		measuredHeightRef.current = nextHeight;
		setMeasuredHeight(nextHeight);
	}, []);

	useLayoutEffect(updateMeasuredHeight, [updateMeasuredHeight]);

	const top =
		measuredHeight > 0
			? Math.max(0, Math.floor((dimensions.height - measuredHeight) / 2))
			: undefined;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes receive terminal mouse events.
		<box
			alignItems="center"
			backgroundColor={active ? backdropColor : undefined}
			height={dimensions.height}
			justifyContent="center"
			left={0}
			onMouseDown={
				active
					? (event) => {
							event.stopPropagation();
							onBackdropClick?.();
						}
					: undefined
			}
			position="absolute"
			top={0}
			width={dimensions.width}
			zIndex={zIndex}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes receive terminal mouse events. */}
			<box
				backgroundColor={backgroundColor}
				border={border}
				flexDirection="column"
				height="auto"
				maxHeight={resolvedMaxHeight}
				onMouseDown={(event) => event.stopPropagation()}
				onSizeChange={updateMeasuredHeight}
				overflow="hidden"
				paddingBottom={paddingValues.bottom}
				paddingLeft={paddingValues.left}
				paddingRight={paddingValues.right}
				paddingTop={paddingValues.top}
				position={top === undefined ? "relative" : "absolute"}
				ref={frameRef}
				top={top}
				width={resolvedWidth}
			>
				<box flexDirection="column" flexShrink={0}>
					{children}
				</box>
			</box>
		</box>
	);
}
