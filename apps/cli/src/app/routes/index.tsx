import { createFileRoute } from "@tanstack/react-router";

import { HomeView } from "@/modules/conversations/ui/views/home-view";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	return <HomeView />;
}
