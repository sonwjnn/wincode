import { createFileRoute, useLocation } from "@tanstack/react-router";
import { toSessionMessageId } from "@wincode/agent-core";
import { isNonEmptyString, isObjectLike } from "@wincode/runtime-utils";
import { useMemo } from "react";
import { SessionSurface } from "@/modules/sessions/ui/views/session-surface";
import type { SessionInitialSubmission } from "@/modules/sessions/ui/views/session-view";
import { toSessionId } from "@/shared/identifiers";

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

/**
 * The route keeps what is the navigation's: which session to mount and the
 * transient submission that starts its first turn. Opening the session — its
 * capabilities, its Host, and the asynchronous boundary that owns both — is
 * the Session Surface's.
 */
function SessionRoute() {
	const { id } = Route.useParams();
	const location = useLocation();
	const sessionId = toSessionId(id);
	const initialSubmission = useMemo(
		() => readInitialSubmission(location.state),
		[location.state]
	);

	return (
		<SessionSurface
			initialSubmission={initialSubmission}
			sessionId={sessionId}
		/>
	);
}
