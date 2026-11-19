import { useRenderer } from "@wincode/tui";
import { MouseButton, type MouseEvent } from "@wincode/tui/core";
import type { ReactNode } from "react";
import { requestSelectionCopy } from "@/shared/clipboard";
import { clickedLink } from "@/shared/links/clicked-link";
import { openExternalLink } from "@/shared/links/open-external-link";

type Props = {
	children: ReactNode;
};

export function ThemedRoot({ children }: Props) {
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
			backgroundColor="transparent"
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
