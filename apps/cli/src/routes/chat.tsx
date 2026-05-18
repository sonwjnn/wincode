import { createFileRoute } from "@tanstack/react-router";
import { ChatScreen } from "../screens/chat";

export const Route = createFileRoute("/chat")({
	component: ChatScreen,
});
