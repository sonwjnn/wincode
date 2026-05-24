import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import { honoClient } from "../../../lib/client";
import { useAsyncRouteData } from "../../../lib/use-async-route-data";
import { ChatScreen } from "../../../screens/chat";

const sessionRouteStateSchema = z
	.object({
		input: z.string().optional(),
	})
	.passthrough();

const isMessagesResponse = (value: unknown): value is { messages: unknown } =>
	typeof value === "object" && value !== null && "messages" in value;

const getInitialPrompt = (state: unknown): string => {
	const result = sessionRouteStateSchema.safeParse(state);

	if (!result.success) {
		return "";
	}

	return result.data.input ?? "";
};

const loadSessionMessages = async (id: string): Promise<UIMessage[]> => {
	const response = await honoClient.api.sessions[":id"].messages.$get({
		param: { id },
	});

	if (!response.ok) {
		throw new Error("Could not load chat messages.");
	}

	const data: unknown = await response.json();

	if (!isMessagesResponse(data)) {
		throw new Error("Invalid chat messages response.");
	}

	const validation = await safeValidateUIMessages({
		messages: data.messages,
	});

	if (!validation.success) {
		throw new Error("Invalid chat messages response.");
	}

	return validation.data;
};

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
	const { id } = Route.useParams();
	const prompt = useRouterState({
		select: (state) => getInitialPrompt(state.location.state),
	});
	const messagesState = useAsyncRouteData({
		deps: [id],
		errorMessage: "Could not load chat messages.",
		load: () => loadSessionMessages(id),
	});

	if (messagesState.status === "loading") {
		return <text>Loading session...</text>;
	}

	if (messagesState.status === "error") {
		return <text fg="red">{messagesState.message}</text>;
	}

	return (
		<ChatScreen
			initialMessages={messagesState.data}
			initialPrompt={prompt}
			sessionId={id}
		/>
	);
}
