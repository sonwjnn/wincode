import { MouseButton, type MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import type { ReactNode } from "react";
import { requestSelectionCopy } from "@/shared/clipboard";
import { clickedLink } from "@/shared/links/clicked-link";
import { openExternalLink } from "@/shared/links/open-external-link";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type Props = {
	children: ReactNode;
};

export function ThemedRoot({ children }: Props) {
	const { colors } = useTheme();
	const renderer = useRenderer();
	const handleMouseDown = (event: MouseEvent): void => {
		if (event.button !== MouseButton.RIGHT) {
			return;
		}
		if (requestSelectionCopy()) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const handleMouseUp = (event: MouseEvent): void => {
		const url = clickedLink(renderer, event);
		if (!url) {
			return;
		}
		void openExternalLink(url);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			backgroundColor={colors.background}
			flexGrow={1}
			height="100%"
			onMouseDown={handleMouseDown}
			onMouseUp={handleMouseUp}
			width="100%"
		>
			{children}
		</box>
	);
}
