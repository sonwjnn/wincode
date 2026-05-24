import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sessions")({
	component: SessionsLayout,
});

function SessionsLayout() {
	return (
		<box flexDirection="column" flexGrow={1} height="100%" width="100%">
			<Outlet />
		</box>
	);
}
