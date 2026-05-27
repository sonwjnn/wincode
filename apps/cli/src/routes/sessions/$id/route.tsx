import { createFileRoute, useRouterState } from "@tanstack/react-router";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { safeValidateUIMessages } from "ai";
import { useEffect, useState } from "react";
import { z } from "zod";
import { honoClient } from "../../../lib/client";
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

const loadSessionMessages = async (
	id: string
): Promise<CodingAgentUIMessage[]> => {
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

	const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
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
	const [messages, setMessages] = useState<CodingAgentUIMessage[] | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const prompt = useRouterState({
		select: (state) => getInitialPrompt(state.location.state),
	});

	useEffect(() => {
		let ignore = false;
		setMessages(null);
		setErrorMessage(null);

		loadSessionMessages(id)
			.then((loadedMessages) => {
				if (!ignore) {
					setMessages(loadedMessages);
				}
			})
			.catch((error: unknown) => {
				if (!ignore) {
					setErrorMessage(
						error instanceof Error
							? error.message
							: "Could not load chat messages."
					);
				}
			});

		return () => {
			ignore = true;
		};
	}, [id]);

	if (errorMessage) {
		return <text fg="red">{errorMessage}</text>;
	}

	if (!messages) {
		return <text>Loading session...</text>;
	}

	return (
		<ChatScreen
			initialMessages={messages}
			initialPrompt={prompt}
			sessionId={id}
		/>
	);
}
