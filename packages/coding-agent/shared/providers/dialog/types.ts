import type { DialogFramePadding } from "@wincode/tui";
import type { ReactNode } from "react";

export type DialogPadding = DialogFramePadding;

export type DialogMargin = {
	left?: number;
	right?: number;
	top?: number;
	bottom?: number;
};

export type DialogConfig = {
	title: string;
	children: ReactNode;
	layerId?: string;
	width?: number;
	padding?: DialogPadding;
	restoreFocus?: boolean;
};
