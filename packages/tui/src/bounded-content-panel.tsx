import { memo, type ReactNode } from "react";

/** Lays out content to the available width without owning the host's scroll viewport. */
export type BoundedContentPanelProps = Readonly<{
	children: ReactNode;
}>;

export const BoundedContentPanel = memo(function BoundedContentPanel({
	children,
}: BoundedContentPanelProps) {
	return <box width="100%">{children}</box>;
});
