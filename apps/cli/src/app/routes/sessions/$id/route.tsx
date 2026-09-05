import { createFileRoute } from "@tanstack/react-router";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { useEffect, useState } from "react";
import {
	type ConversationCompaction,
	rebuildActiveMessages,
} from "@/modules/conversations/compaction";
import {
	type ConversationMessage,
	sanitizeInterruptedConversationMessages,
} from "@/modules/conversations/message";
import { projectConversationRecords } from "@/modules/conversations/storage/conversation-record";
import type { PendingInitialTurn } from "@/modules/conversations/storage/conversation-store";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import { ChatView } from "@/modules/conversations/ui/views/chat-view";
import { mergePendingInitialMessage } from "@/modules/conversations/utils";
import { useTheme } from "@/shared/providers/theme/theme-provider";

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
		pendingInitialTurn?: PendingInitialTurn;
		variant?: ModelVariant;
	} | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
			store.getPendingInitialTurn(id),
		])
			.then(
				async ([session, loadedCompactions, records, pendingInitialTurn]) => {
					if (ignore) {
						return;
					}
					const projected = projectConversationRecords(records);
					const sourceMessages = mergePendingInitialMessage(
						projected,
						pendingInitialTurn?.message
					);
					const displayMessages = store.attachmentStore
						? await store.attachmentStore.annotateMessagesForDisplay(
								sourceMessages
							)
						: sourceMessages;
					if (ignore) {
						return;
					}
					const restored =
						sanitizeInterruptedConversationMessages(displayMessages);
					const active = restored.filter(
						(message) => !message.id.startsWith("delegated-turn:")
					);
					const latestCompaction = loadedCompactions.at(-1) ?? null;
					setMessages(restored);
					setActiveMessages(rebuildActiveMessages(active, latestCompaction));
					setCompactions(loadedCompactions);
					setSessionConfig({
						...(session.model ? { model: session.model } : {}),
						...(pendingInitialTurn ? { pendingInitialTurn } : {}),
						...(session.variant ? { variant: session.variant } : {}),
					});
					setSessionTitle(session.title);
				}
			)
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
			initialActiveMessages={activeMessages}
			initialCompactions={compactions}
			initialMessages={messages}
			initialModel={sessionConfig.model}
			initialPendingTurn={sessionConfig.pendingInitialTurn}
			initialVariant={sessionConfig.variant}
			mode="session"
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
