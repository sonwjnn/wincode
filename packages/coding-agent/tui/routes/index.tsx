import { createFileRoute } from "@tanstack/react-router";

import { NewSessionView } from "@/modules/sessions/ui/views/new-session-view";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	return <NewSessionView />;
}
