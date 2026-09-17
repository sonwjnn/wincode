import { createFileRoute, useLocation } from "@tanstack/react-router";
import { toSessionMessageId } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import {
	getErrorMessage,
	isNonEmptyString,
	isObjectLike,
	pickTruthy,
} from "@wincode/runtime-utils";
import { useEffect, useMemo, useState } from "react";
import {
	rebuildActiveMessages,
	type SessionCompaction,
} from "@/modules/sessions/compaction";
import {
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "@/modules/sessions/message";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { projectSessionRecords } from "@/modules/sessions/storage/session-record";
import {
	type SessionInitialSubmission,
	SessionView,
} from "@/modules/sessions/ui/views/session-view";
import { toSessionId } from "@/shared/identifiers";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const readInitialSubmission = (
	state: unknown
): SessionInitialSubmission | undefined => {
	if (!(isObjectLike(state) && "initialSubmission" in state)) {
		return;
	}
	const submission = state.initialSubmission;
	if (
		!(
			isObjectLike(submission) &&
			"messageId" in submission &&
			isNonEmptyString(submission.messageId)
		)
	) {
		return;
	}
	return { messageId: toSessionMessageId(submission.messageId) };
};

export const Route = createFileRoute("/sessions/$id")({
	component: SessionRoute,
});

function SessionRoute() {
	const { colors } = useTheme();
	const { id } = Route.useParams();
	const location = useLocation();
	const sessionId = toSessionId(id);
	const initialSubmission = useMemo(
		() => readInitialSubmission(location.state),
		[location.state]
	);
	const [messages, setMessages] = useState<SessionMessage[] | null>(null);
	const [activeMessages, setActiveMessages] = useState<SessionMessage[] | null>(
		null
	);
	const [compactions, setCompactions] = useState<SessionCompaction[]>([]);
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

		const store = getSessionStore();

		Promise.all([
			store.getSession(sessionId),
			store.getCompactions(sessionId),
			store.listSessionRecords(sessionId),
		])
			.then(async ([session, loadedCompactions, records]) => {
				if (ignore) {
					return;
				}
				const projected = projectSessionRecords(records);
				const displayMessages = store.attachmentStore
					? await store.attachmentStore.annotateMessagesForDisplay(projected)
					: projected;
				if (ignore) {
					return;
				}
				const restored = sanitizeInterruptedSessionMessages(displayMessages);
				const active = restored.filter(
					(message) => !message.id.startsWith("delegated-turn:")
				);
				const latestCompaction = loadedCompactions.at(-1) ?? null;
				setMessages(restored);
				setActiveMessages(rebuildActiveMessages(active, latestCompaction));
				setCompactions(loadedCompactions);
				setSessionConfig(
					pickTruthy({ model: session.model, variant: session.variant })
				);
				setSessionTitle(session.title);
			})
			.catch((error: unknown) => {
				if (!ignore) {
					setErrorMessage(getErrorMessage(error, "Could not load session."));
				}
			});

		return () => {
			ignore = true;
		};
	}, [sessionId]);

	if (errorMessage) {
		return <text fg={colors.error}>{errorMessage}</text>;
	}

	if (!(messages && activeMessages && sessionTitle && sessionConfig)) {
		return <text fg={colors.text}>Loading session...</text>;
	}

	return (
		<SessionView
			initialCompactions={compactions}
			initialContext={activeMessages}
			initialModel={sessionConfig.model}
			initialSubmission={initialSubmission}
			initialTranscript={messages}
			initialVariant={sessionConfig.variant}
			sessionId={sessionId}
			sessionTitle={sessionTitle}
		/>
	);
}
