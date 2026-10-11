import type { ReactNode } from "react";
import { DEFAULT_DIALOG_CONTENT_MARGIN } from "../providers/dialog/defaults";
import type { DialogMargin } from "../providers/dialog/types";

type DialogInsetProps = Readonly<{
	children: ReactNode;
	margin?: DialogMargin;
}>;

/** Aligns regular dialog content with the shared dialog gutter. */
export function DialogInset({
	children,
	margin = DEFAULT_DIALOG_CONTENT_MARGIN,
}: DialogInsetProps) {
	return (
		<box
			marginBottom={margin.bottom}
			marginLeft={margin.left}
			marginRight={margin.right}
			marginTop={margin.top}
		>
			{children}
		</box>
	);
}
