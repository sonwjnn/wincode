import { createFileRoute } from "@tanstack/react-router";

import { HomeScreen } from "../../modules/conversations/ui/views/home-screen";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	return <HomeScreen />;
}
