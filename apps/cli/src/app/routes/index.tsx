import { createFileRoute } from "@tanstack/react-router";

import { ChatView } from "@/modules/conversations/ui/views/chat-view";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	return <ChatView mode="home" />;
}
