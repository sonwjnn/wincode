import { createFileRoute, useLocation } from "@tanstack/react-router";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { useEffect, useMemo, useState } from "react";
import {
	type ConversationCompaction,
	rebuildActiveMessages,
} from "@/modules/conversations/compaction";
import {
	type ConversationMessage,
	sanitizeInterruptedConversationMessages,
} from "@/modules/conversations/message";
import { projectConversationRecords } from "@/modules/conversations/storage/conversation-record";
import { getConversationStore } from "@/modules/conversations/storage/get-conversation-store";
import {
	ChatView,
	type SessionInitialSubmission,
} from "@/modules/conversations/ui/views/chat-view";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const readInitialSubmission = (
	state: unknown
): SessionInitialSubmission | undefined => {
	if (
		typeof state !== "object" ||
		state === null ||
		!("initialSubmission" in state)
	) {
		return;
	}
	const submission = state.initialSubmission;
	if (
		typeof submission !== "object" ||
		submission === null ||
		!("messageId" in submission) ||
		typeof submission.messageId !== "string" ||
		submission.messageId.length === 0
	) {
		return;
	}
	return { messageId: submission.messageId };
};

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
	const { colors } = useTheme();
	const { id } = Route.useParams();
	const location = useLocation();
	const initialSubmission = useMemo(
		() => readInitialSubmission(location.state),
		[location.state]
	);
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
			.then(async ([session, loadedCompactions, records]) => {
				if (ignore) {
					return;
				}
				const projected = projectConversationRecords(records);
				const displayMessages = store.attachmentStore
					? await store.attachmentStore.annotateMessagesForDisplay(projected)
					: projected;
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
			initialSubmission={initialSubmission}
			initialVariant={sessionConfig.variant}
			mode="session"
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
