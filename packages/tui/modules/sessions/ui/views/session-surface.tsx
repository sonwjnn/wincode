import { getErrorMessage } from "@wincode/runtime-utils";
import { useEffect, useState } from "react";
import { createSessionHost } from "@/modules/sessions/host/session-host";
import type { SessionHost } from "@/modules/sessions/host/types";
import { useSessionCapabilities } from "@/modules/sessions/host/use-session-capabilities";
import type { SessionMessage } from "@/modules/sessions/message";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import type { SessionId } from "@/shared/identifiers";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionInitialSubmission } from "./session-view";
import { SessionView } from "./session-view";

type OpenedSession = Readonly<{
	host: SessionHost;
	sessionTitle: string;
	transcript: readonly SessionMessage[];
}>;

/**
 * Opens one session and renders it. This is the surface that owns the
 * asynchronous boundary: it constructs the Session Host, shows the opening
 * state until the session exists, and shows the failure when it cannot open —
 * the Engine does not exist until opening completes.
 *
 * It owns the session's presentation-only facts as well: the title read from the
 * session row, and the display-only annotation of the Transcript, which marks
 * attachment parts whose content is gone. Annotation never reaches the Session
 * Context, which the Host derives from the un-annotated projection.
 *
 * The consumer that constructs a Host owns calling `shutdown`, so this surface
 * shuts the session down when it unmounts or when the session it shows changes.
 */
export function SessionSurface({
	initialSubmission,
	sessionId,
}: {
	readonly initialSubmission?: SessionInitialSubmission;
	readonly sessionId: SessionId;
}) {
	const { colors } = useTheme();
	const capabilities = useSessionCapabilities();
	const [session, setSession] = useState<OpenedSession | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	useEffect(() => {
		let ignore = false;
		let openedHost: SessionHost | null = null;
		setSession(null);
		setErrorMessage(null);
		const open = async (): Promise<OpenedSession | null> => {
			const host = await createSessionHost({ capabilities, sessionId });
			if (ignore) {
				// The surface is gone: nobody would own this session.
				host.shutdown();
				return null;
			}
			openedHost = host;
			try {
				const store = getSessionStore();
				const [row, transcript] = await Promise.all([
					store.getSession(sessionId),
					store.attachmentStore
						? store.attachmentStore.annotateMessagesForDisplay(
								host.getSnapshot().transcript
							)
						: host.getSnapshot().transcript,
				]);
				if (ignore) {
					return null;
				}
				return {
					host,
					sessionTitle: row.title,
					transcript: host.engine.mergeTranscript(transcript),
				};
			} catch (error) {
				// The session opened but its surface could not be prepared. The
				// unmount cleanup already ended it when the surface was gone, so
				// this shuts it down only while this effect still owns it, and
				// never leaves the handle for a second call.
				openedHost = null;
				if (!ignore) {
					host.shutdown();
				}
				throw error;
			}
		};

		open()
			.then((next) => {
				if (next && !ignore) {
					setSession(next);
				}
			})
			.catch((error: unknown) => {
				if (!ignore) {
					setErrorMessage(getErrorMessage(error, "Could not load session."));
				}
			});

		return () => {
			ignore = true;
			openedHost?.shutdown();
		};
	}, [capabilities, sessionId]);

	if (errorMessage) {
		return <text fg={colors.error}>{errorMessage}</text>;
	}

	if (!session) {
		return <text fg={colors.text}>Loading session...</text>;
	}

	return (
		<SessionView
			host={session.host}
			initialSubmission={initialSubmission}
			initialTranscript={session.transcript}
			sessionId={sessionId}
			sessionTitle={session.sessionTitle}
		/>
	);
}
