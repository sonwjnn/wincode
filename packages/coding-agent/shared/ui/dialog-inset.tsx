import type { ReactNode } from "react";
import { DEFAULT_DIALOG_CONTENT_MARGIN_X } from "../providers/dialog/defaults";

type DialogInsetProps = Readonly<{
	children: ReactNode;
	marginX?: number;
}>;

/** Aligns regular dialog content with the shared dialog gutter. */
export function DialogInset({
	children,
	marginX = DEFAULT_DIALOG_CONTENT_MARGIN_X,
}: DialogInsetProps) {
	return <box marginX={marginX}>{children}</box>;
}
