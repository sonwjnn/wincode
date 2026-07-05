import { createFileRoute, useRouterState } from "@tanstack/react-router";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { codingModeNameSchema } from "@wincode/ai";
import { useEffect, useState } from "react";
import { z } from "zod";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import { ChatView } from "@/modules/conversations/ui/views/chat-view";

const sessionRouteStateSchema = z
	.object({
		autoStart: z.boolean().optional(),
		input: z.string().optional(),
		mode: codingModeNameSchema.optional(),
	})
	.passthrough();

const getInitialPrompt = (state: unknown): string => {
	const result = sessionRouteStateSchema.safeParse(state);

	if (!result.success) {
		return "";
	}

	return result.data.input ?? "";
};

const getAutoStart = (state: unknown): boolean => {
	const result = sessionRouteStateSchema.safeParse(state);

	if (!result.success) {
		return false;
	}

	return result.data.autoStart ?? false;
};

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
	const { id } = Route.useParams();
	const [messages, setMessages] = useState<CodingAgentUIMessage[] | null>(null);
	const [sessionTitle, setSessionTitle] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const prompt = useRouterState({
		select: (state) => getInitialPrompt(state.location.state),
	});
	const autoStart = useRouterState({
		select: (state) => getAutoStart(state.location.state),
	});

	useEffect(() => {
		let ignore = false;
		setMessages(null);
		setSessionTitle(null);
		setErrorMessage(null);

		const store = getConversationStore();

		Promise.all([store.getMessages(id), store.getSession(id)])
			.then(([loadedMessages, session]) => {
				if (!ignore) {
					setMessages(loadedMessages);
					setSessionTitle(session.title);
				}
			})
			.catch((error: unknown) => {
				if (!ignore) {
					setErrorMessage(
						error instanceof Error ? error.message : "Could not load session."
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

	if (!(messages && sessionTitle)) {
		return <text>Loading session...</text>;
	}

	return (
		<ChatView
			autoStart={autoStart}
			initialMessages={messages}
			initialPrompt={prompt}
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
