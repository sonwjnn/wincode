import { TextAttributes } from "@opentui/core";
import { createRootRoute } from "@tanstack/react-router";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { RootLayout } from "../layouts/root-layout";

export const Route = createRootRoute({
	component: RootLayout,
	notFoundComponent: NotFound,
});

function NotFound() {
	const { colors } = useTheme();
	return (
		<box alignItems="center" flexGrow={1} justifyContent="center">
			<box alignItems="center" flexDirection="column">
				<text attributes={TextAttributes.BOLD} fg={colors.error}>
					Screen Not Found
				</text>
			</box>
		</box>
	);
}
