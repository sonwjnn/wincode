import { createFileRoute, useRouterState } from "@tanstack/react-router";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { codingModeNameSchema } from "@wincode/ai";
import { safeValidateUIMessages } from "ai";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ChatView } from "@/modules/conversations/ui/views/chat-view";
import { getErrorMessage } from "@/shared/api/error-response";
import { honoClient } from "@/shared/api/hono-client";

const sessionRouteStateSchema = z
	.object({
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

const isMessagesResponse = (value: unknown): value is { messages: unknown } =>
	typeof value === "object" && value !== null && "messages" in value;

const loadSessionMetadata = async (id: string) => {
	const res = await honoClient.api.sessions[":id"].$get({ param: { id } });
	if (!res.ok) {
		throw new Error(await getErrorMessage(res));
	}
	return (await res.json()) as {
		createdAt: string;
		id: string;
		lastMessageAt: string | null;
		pinned: boolean;
		title: string | null;
	};
};

const loadSessionMessages = async (
	id: string
): Promise<CodingAgentUIMessage[]> => {
	const response = await honoClient.api.sessions[":id"].messages.$get({
		param: { id },
	});

	if (!response.ok) {
		throw new Error(await getErrorMessage(response));
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
	const [sessionTitle, setSessionTitle] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const prompt = useRouterState({
		select: (state) => getInitialPrompt(state.location.state),
	});

	useEffect(() => {
		let ignore = false;
		setMessages(null);
		setSessionTitle(null);
		setErrorMessage(null);

		Promise.all([loadSessionMessages(id), loadSessionMetadata(id)])
			.then(([loadedMessages, metadata]) => {
				if (!ignore) {
					setMessages(loadedMessages);
					setSessionTitle(metadata.title ?? "Untitled Session");
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
			initialMessages={messages}
			initialPrompt={prompt}
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
