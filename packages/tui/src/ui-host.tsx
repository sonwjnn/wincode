import type { CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";

type UiHost = Readonly<{
	render: (node: ReactNode) => void;
	unmount: () => void;
}>;

/** Creates a React root for a renderer whose lifecycle belongs to the caller. */
export const createUiHost = (renderer: CliRenderer): UiHost => {
	const root = createRoot(renderer);
	let mounted = true;
	return Object.freeze({
		render(node: ReactNode): void {
			if (!mounted) {
				throw new Error("Cannot render into an unmounted UI host");
			}
			root.render(node);
		},
		unmount(): void {
			if (!mounted) {
				return;
			}
			mounted = false;
			root.unmount();
		},
	});
};

export type { UiHost };
