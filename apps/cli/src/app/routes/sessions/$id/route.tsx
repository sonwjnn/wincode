import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { agentIdSchema } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
	type ConversationCompaction,
	rebuildActiveMessages,
} from "@/modules/conversations/compaction";
import {
	type ConversationMessage,
	isConversationMessage,
	sanitizeInterruptedConversationMessages,
} from "@/modules/conversations/message";
import { projectConversationRecords } from "@/modules/conversations/storage/conversation-record";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import { ChatView } from "@/modules/conversations/ui/views/chat-view";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const sessionRouteStateSchema = z
	.object({
		agent: agentIdSchema.optional(),
		autoStart: z.boolean().optional(),
		initialMessage: z.unknown().optional(),
	})
	.passthrough();

const getRouteState = (
	state: unknown
): z.infer<typeof sessionRouteStateSchema> | null => {
	const result = sessionRouteStateSchema.safeParse(state);
	return result.success ? result.data : null;
};

const getAutoStart = (state: unknown): boolean =>
	getRouteState(state)?.autoStart ?? false;

const getInitialMessage = (state: unknown): ConversationMessage | undefined => {
	const candidate = getRouteState(state)?.initialMessage;
	return isConversationMessage(candidate) ? candidate : undefined;
};

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
	const { colors } = useTheme();
	const { id } = Route.useParams();
	const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
	const [activeMessages, setActiveMessages] = useState<
		ConversationMessage[] | null
	>(null);
	const [compactions, setCompactions] = useState<ConversationCompaction[]>([]);
	const [sessionTitle, setSessionTitle] = useState<string | null>(null);
	const [sessionConfig, setSessionConfig] = useState<{
		model?: ChatModelSelection;
		variant?: ModelVariant;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const routeState = useRouterState({
		select: (state) => state.location.state,
	});
	const autoStart = getAutoStart(routeState);
	const initialMessage = getInitialMessage(routeState);

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
			store.getSession(id),
			store.getCompactions(id),
			store.listConversationRecords(id),
		])
			.then(([session, loadedCompactions, records]) => {
				if (ignore) {
					return;
				}
				const projected = projectConversationRecords(records);
				const restored = sanitizeInterruptedConversationMessages(
					projected.length === 0 && initialMessage !== undefined
						? [initialMessage]
						: projected
				);
				const active = restored.filter(
					(message) => !message.id.startsWith("delegated-turn:")
				);
				const latestCompaction = loadedCompactions.at(-1) ?? null;
				setMessages(restored);
				setActiveMessages(rebuildActiveMessages(active, latestCompaction));
				setCompactions(loadedCompactions);
				setSessionConfig({
					...(session.model ? { model: session.model } : {}),
					...(session.variant ? { variant: session.variant } : {}),
				});
				setSessionTitle(session.title);
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
	}, [id, initialMessage]);

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
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
