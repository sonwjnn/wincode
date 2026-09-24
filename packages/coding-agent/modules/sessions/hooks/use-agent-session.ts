import type { ToolCallId } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { omitUndefined } from "@wincode/runtime-utils";
import { useEffect, useMemo, useState } from "react";
import { projectSessionApprovals } from "@/modules/sessions/approval-projection";
import type { CompactSessionResult } from "@/modules/sessions/compaction/compaction";
import type {
	SessionSnapshot,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "@/modules/sessions/engine/types";
import type { SessionHost } from "@/modules/sessions/host/types";
import type {
	SessionSendInput,
	SessionSendOutcome,
} from "@/modules/sessions/session-operation";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";

export type AgentSessionBinding = Readonly<{
	/** Cancels the Agent Turn the session is running. */
	cancel: () => void;
	/** Aborts the compaction command in flight and recalls the waiting messages with it. */
	cancelCompaction: () => SessionWaitingMessage[];
	/** Runs a manual compaction command against one Model Target. */
	compact: (
		focus: string | undefined,
		selection: ChatModelSelection,
		selectionVariant?: ModelVariant
	) => Promise<CompactSessionResult>;
	/** Interrupts the Agent Turn the session is running and recalls everything waiting. */
	interrupt: (preserveToolCallId?: ToolCallId) => SessionWaitingMessage[];
	/**
	 * Withdraws the session's waiting user messages for the composer, in the
	 * order they would run: the Steering Lane first, then the Submission Queue.
	 */
	recallWaitingMessages: (
		ids?: readonly SessionWaitingMessageId[]
	) => SessionWaitingMessage[];
	/** Sends one submission as a Session Command. */
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	/** The session facts the view renders at one moment. */
	snapshot: SessionSnapshot;
}>;

/**
 * Binds an already-open Session Host to React: it mirrors the Agent Session's
 * Snapshot into React state so the view re-renders, projects its approvals into
 * the panel surface, and forwards session commands. It holds no session state
 * and opens nothing: the Agent Session is the only writer, and every fact this
 * binding renders comes from a snapshot it read.
 *
 * The snapshot is mirrored through a subscription rather than
 * `useSyncExternalStore`: the synchronous re-render that hook performs inside
 * the submit path stalls the automatic-compaction journey in the OpenTUI test
 * renderer (`useSyncExternalStore` does receive updates in this renderer in
 * isolation, so this is about that interaction, not about the renderer dropping
 * notifications). The binding re-reads the snapshot once after subscribing, so
 * a change between render and effect is not lost.
 */
export function useAgentSession(host: SessionHost): AgentSessionBinding {
	const { agentSession } = host;
	const { project: projectApprovalPanels } = useApprovalPanels();
	const [snapshot, setSnapshot] = useState(agentSession.getSnapshot);
	useEffect(() => {
		setSnapshot(agentSession.getSnapshot());
		return agentSession.subscribe(() =>
			setSnapshot(agentSession.getSnapshot())
		);
	}, [agentSession]);
	// The panel surface reads the Agent Session's approvals; the binding only
	// projects them and never reads a settlement back out of it.
	const approvalEntries = useMemo(
		() =>
			projectSessionApprovals(
				snapshot.approvals,
				agentSession.respondToApproval
			),
		[agentSession.respondToApproval, snapshot.approvals]
	);
	useEffect(() => {
		projectApprovalPanels(approvalEntries);
	}, [approvalEntries, projectApprovalPanels]);
	useEffect(
		() => () => {
			// The projection clears with the view that showed it; the session
			// itself is the owner's to shut down.
			projectApprovalPanels([]);
		},
		[projectApprovalPanels]
	);
	const compact = useMemo(
		() =>
			(
				focus: string | undefined,
				selection: ChatModelSelection,
				selectionVariant?: ModelVariant
			) =>
				agentSession.compact({
					focus,
					model: selection,
					trigger: "manual",
					...omitUndefined({ variant: selectionVariant }),
				}),
		[agentSession]
	);

	return {
		cancel: agentSession.cancel,
		cancelCompaction: agentSession.cancelCompaction,
		compact,
		interrupt: agentSession.interrupt,
		recallWaitingMessages: agentSession.recallWaitingMessages,
		send: agentSession.send,
		snapshot,
	};
}
