import { TextAttributes } from "@opentui/core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { honoClient } from "../../lib/client";
import { getErrorMessage } from "../../lib/error-response";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";

type Session = {
	createdAt: string;
	id: string;
	lastMessageAt: string | null;
	title: string;
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

export const SessionsDialogContent = () => {
	const [sessions, setSessions] = useState<Session[]>([]);
	const [loading, setLoading] = useState(true);
	const { close } = useDialog();
	const navigate = useNavigate();
	const { show } = useToast();

	useEffect(() => {
		let ignore = false;

		const fetchSessions = async () => {
			try {
				const res = await honoClient.api.sessions.$get();
				if (!res.ok) {
					throw new Error(await getErrorMessage(res));
				}

				const data = await res.json();

				if (!ignore) {
					setSessions(data);
					setLoading(false);
				}
			} catch (error) {
				if (!ignore) {
					show({
						variant: "error",
						message:
							error instanceof Error
								? error.message
								: "Failed to fetch sessions",
					});
					close();
				}
			}
		};

		fetchSessions();

		return () => {
			ignore = true;
		};
	}, [close, show]);

	const handleSelect = useCallback(
		(session: Session) => {
			close();
			navigate({ params: { id: session.id }, to: "/sessions/$id" }).catch(
				() => undefined
			);
		},
		[close, navigate]
	);

	if (loading) {
		return (
			<box flexDirection="column">
				<text attributes={TextAttributes.DIM}>Loading sessions...</text>
			</box>
		);
	}

	return (
		<DialogSearchList
			emptyText="No matching sessions"
			filterFn={(s, query) =>
				s.title.toLowerCase().includes(query.toLowerCase())
			}
			getKey={(s) => s.id}
			items={sessions}
			onSelect={handleSelect}
			placeholder="Search sessions"
			renderItem={(session, isSelected) => (
				<>
					<text fg={isSelected ? "black" : "white"} selectable={false}>
						{session.title}
					</text>
					<box flexGrow={1} />
					<text
						attributes={TextAttributes.DIM}
						fg={isSelected ? "black" : undefined}
						selectable={false}
					>
						{timeFormatter.format(
							new Date(session.lastMessageAt ?? session.createdAt)
						)}
					</text>
				</>
			)}
		/>
	);
};
