import { createFileRoute, useRouterState } from "@tanstack/react-router";
import {
	type ConversationRecord,
	isAgentTurnTextPart,
} from "@wincode/agent-core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { agentIdSchema } from "@wincode/ai";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { useEffect, useState } from "react";
import { z } from "zod";
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

const DELEGATED_MESSAGE_PREFIX = "delegated-turn:";

/**
 * Synthetic child messages appended for display carry this id prefix. They
 * are excluded whenever persisted rows are loaded so a projection that was
 * written back by a later persist can never duplicate the record-derived
 * transcript; the durable source of truth stays the Conversation Record.
 */
export const isDelegatedDisplayMessage = (
	message: CodingAgentUIMessage
): boolean => message.id.startsWith(DELEGATED_MESSAGE_PREFIX);

/** The internal Skill-context row is model-only input, never user-visible. */
const isInternalContextMessage = (
	message: ConversationRecord["messages"][number]
) => message.id === "skill-context";

const projectedParts = (
	message: ConversationRecord["messages"][number]
): CodingAgentUIMessage["parts"] =>
	message.parts
		.filter(isAgentTurnTextPart)
		.map(({ text }) => ({ text, type: "text" as const }));

const delegatedDisplayMessages = (
	records: readonly ConversationRecord[]
): CodingAgentUIMessage[] =>
	records.flatMap((record) => {
		if (record.delegation === undefined) {
			return [];
		}
		const messages: CodingAgentUIMessage[] = [];
		record.messages.forEach((message, messageIndex) => {
			if (isInternalContextMessage(message)) {
				return;
			}
			const parts = projectedParts(message);
			if (parts.length === 0) {
				return;
			}
			messages.push({
				id: `${DELEGATED_MESSAGE_PREFIX}${record.turnId}:${messageIndex}:${message.id}`,
				metadata: { agent: record.agentId },
				parts,
				role: message.role,
			});
		});
		if (record.outcome.kind === "completed") {
			return messages;
		}
		// A failed, cancelled, or interrupted child may never reach assistant
		// text; its terminal state is the durable answer and must be visible.
		const hasAssistantText = messages.some(
			(message) => message.role === "assistant"
		);
		if (hasAssistantText) {
			return messages;
		}
		messages.push({
			id: `${DELEGATED_MESSAGE_PREFIX}${record.turnId}:outcome`,
			metadata: { agent: record.agentId, interrupted: true },
			parts: [
				{
					text: `${record.outcome.kind}: ${record.outcome.failure.message}`,
					type: "text",
				},
			],
			role: "assistant",
		} satisfies CodingAgentUIMessage);
		return messages;
	});

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
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
			store.listConversationRecords(id),
		])
			.then(([loadedMessages, session, loadedCompactions, records]) => {
				if (!ignore) {
					// A turn interrupted before its tool calls finished must not
					// restore as stuck running blocks: strip their unfinished parts.
					// Synthetic delegated rows that a prior persist wrote back are
					// re-derived from Conversation Records, never double-rendered.
					const displayMessages = sanitizeInterruptedMessagesForConversation(
						loadedMessages.filter(
							(message) => !isDelegatedDisplayMessage(message)
						)
					);
					const latestCompaction = loadedCompactions.at(-1) ?? null;
					setMessages([
						...displayMessages,
						...delegatedDisplayMessages(records),
					]);
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
			sessionId={id}
			sessionTitle={sessionTitle}
		/>
	);
}
