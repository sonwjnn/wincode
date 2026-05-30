import { TextAttributes } from "@opentui/core";
import { createRootRoute } from "@tanstack/react-router";
import { RootLayout } from "../layouts/root-layout";

export const Route = createRootRoute({
	component: RootLayout,
	notFoundComponent: NotFound,
});

function NotFound() {
	return (
		<box alignItems="center" flexGrow={1} justifyContent="center">
			<box alignItems="center" flexDirection="column">
				<text attributes={TextAttributes.BOLD} fg="red">
					Screen Not Found
				</text>
			</box>
		</box>
	);
}
