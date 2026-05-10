import { TextAttributes } from "@opentui/core";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: Home,
});

function Home() {
	return (
		<box alignItems="center" flexGrow={1} justifyContent="center">
			<box alignItems="flex-end" justifyContent="center">
				<ascii-font font="tiny" text="OpenTUI" />
				<text attributes={TextAttributes.DIM}>What will you build?</text>
			</box>
		</box>
	);
}
