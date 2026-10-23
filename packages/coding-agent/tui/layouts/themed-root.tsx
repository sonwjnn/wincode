import type { MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { getErrorMessage, logger } from "@wincode/utils";
import open from "open";
import type { ReactNode } from "react";
import { clickedLink } from "@/shared/links/clicked-link";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type Props = {
	children: ReactNode;
};

export function ThemedRoot({ children }: Props) {
	const { colors } = useTheme();
	const renderer = useRenderer();
	const handleMouseUp = (event: MouseEvent): void => {
		const url = clickedLink(renderer, event);
		if (!url) {
			return;
		}
		let protocol: string;
		try {
			protocol = new URL(url).protocol;
		} catch {
			return;
		}
		if (
			!(protocol === "http:" || protocol === "https:" || protocol === "file:")
		) {
			return;
		}
		void open(url).catch((error: unknown) => {
			void logger.warn("Failed to open link.", {
				error: getErrorMessage(error, "Unknown link error."),
				url,
			});
		});
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			backgroundColor={colors.background}
			flexGrow={1}
			height="100%"
			onMouseUp={handleMouseUp}
			width="100%"
		>
			{children}
		</box>
	);
}
