import type { ReactNode } from "react";

type Props = {
	children: ReactNode;
};

export function ThemedRoot({ children }: Props) {
	return (
		<box flexGrow={1} height="100%" width="100%">
			{children}
		</box>
	);
}
