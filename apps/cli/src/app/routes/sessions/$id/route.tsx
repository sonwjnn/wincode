import { createFileRoute, useRouterState } from "@tanstack/react-router";
import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
} from "@wincode/ai";
import { agentIdSchema } from "@wincode/ai";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useBilling } from "@/modules/billing";
import {
	type ConversationCompaction,
	rebuildActiveMessages,
} from "@/modules/conversations/compaction";
import { sanitizeInterruptedMessagesForConversation } from "@/modules/conversations/hooks/use-chat";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import { ChatView } from "@/modules/conversations/ui/views/chat-view";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const sessionRouteStateSchema = z
	.object({
		agent: agentIdSchema.optional(),
		autoStart: z.boolean().optional(),
		mode: z.string().optional(),
	})
	.passthrough();

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
	const { refresh: refreshBilling } = useBilling();
	const { colors } = useTheme();
	const { id } = Route.useParams();
	const [messages, setMessages] = useState<CodingAgentUIMessage[] | null>(null);
	const [activeMessages, setActiveMessages] = useState<
		CodingAgentUIMessage[] | null
	>(null);
	const [compactions, setCompactions] = useState<ConversationCompaction[]>([]);
	const [sessionTitle, setSessionTitle] = useState<string | null>(null);
	const [sessionConfig, setSessionConfig] = useState<{
		model?: ChatModelSelection;
		variant?: ModelVariant;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const autoStart = useRouterState({
		select: (state) => getAutoStart(state.location.state),
	});

	useEffect(() => {
		let ignore = false;
		setMessages(null);
		setActiveMessages(null);
		setCompactions([]);
		setSessionTitle(null);
		setSessionConfig(null);
		setErrorMessage(null);

		const store = getConversationStore();

		Promise.all([
			store.getMessages(id),
			store.getSession(id),
			store.getCompactions(id),
		])
			.then(([loadedMessages, session, loadedCompactions]) => {
				if (!ignore) {
					// A turn interrupted before its tool calls finished must not
					// restore as stuck running blocks: strip their unfinished parts.
					const displayMessages =
						sanitizeInterruptedMessagesForConversation(loadedMessages);
					const latestCompaction = loadedCompactions.at(-1) ?? null;
					setMessages(displayMessages);
					setActiveMessages(
						rebuildActiveMessages(displayMessages, latestCompaction)
					);
					setCompactions(loadedCompactions);
					setSessionConfig({
						...(session.model ? { model: session.model } : {}),
						...(session.variant ? { variant: session.variant } : {}),
					});
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
		return <text fg={colors.error}>{errorMessage}</text>;
	}

	if (!(messages && activeMessages && sessionTitle && sessionConfig)) {
		return <text fg={colors.text}>Loading session...</text>;
	}

	return (
		<ChatView
			autoStart={autoStart}
			initialActiveMessages={activeMessages}
			initialCompactions={compactions}
			initialMessages={messages}
			initialModel={sessionConfig.model}
			initialVariant={sessionConfig.variant}
			onHostedCompletion={() => {
				refreshBilling().catch(() => undefined);
			}}
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
