import type { ReactNode } from "react";

export type DialogPadding = {
	left?: number;
	right?: number;
	top?: number;
	bottom?: number;
};

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
};
