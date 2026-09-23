import type { ReactNode } from "react";

type SelectableDialogItemProps = {
	children: ReactNode;
	status?: ReactNode;
	statusWidth?: number;
};

export function SelectableDialogItem({
	children,
	status,
	statusWidth = 3,
}: SelectableDialogItemProps) {
	return (
		<box flexDirection="row" flexGrow={1}>
			<box flexShrink={0} marginLeft={1} width={Math.max(1, statusWidth - 1)}>
				{status}
			</box>
			<box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
				{children}
			</box>
		</box>
	);
}
