import type { ToolCallId } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { omitUndefined } from "@wincode/runtime-utils";
import { useEffect, useMemo, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
import { useMcp } from "@/modules/mcp";
import { useToolPermission } from "@/modules/permissions";
import { projectSessionApprovals } from "@/modules/sessions/approval-projection";
import type { CompactSessionResult } from "@/modules/sessions/compaction/compaction";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import { estimateCompactionTokens } from "@/modules/sessions/compaction/config";
import { createDirectSummaryGenerator } from "@/modules/sessions/compaction/summary-generator";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import { useCompactionSettings } from "@/modules/sessions/compaction/use-compaction-settings";
import { createSessionEngine } from "@/modules/sessions/engine/session-engine";
import type {
	SessionEngine,
	SessionQueuedSubmission,
	SessionSnapshot,
} from "@/modules/sessions/engine/types";
import { createSessionEngineHost } from "@/modules/sessions/hooks/session-engine-host";
import type { SessionMessage } from "@/modules/sessions/message";
import type {
	SessionSendInput,
	SessionSendOutcome,
} from "@/modules/sessions/session-operation";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import type { QueuedSubmissionId, SessionId } from "@/shared/identifiers";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";

export type SessionEngineBinding = Readonly<{
	/** Cancels the Agent Turn the session is running. */
	cancel: () => void;
	/** Aborts the compaction command in flight and recalls the queue with it. */
	cancelCompaction: () => SessionQueuedSubmission[];
	/** Runs a manual compaction command against one Model Target. */
	compact: (
		focus: string | undefined,
		selection: ChatModelSelection,
		selectionVariant?: ModelVariant
	) => Promise<CompactSessionResult>;
	/** Interrupts the Agent Turn the session is running and recalls the queue. */
	interrupt: (preserveToolCallId?: ToolCallId) => SessionQueuedSubmission[];
	/** Withdraws the Queue Submissions for the composer, oldest first. */
	recallQueuedSubmissions: (
		ids?: readonly QueuedSubmissionId[]
	) => SessionQueuedSubmission[];
	/** Sends one submission as a Session Command. */
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	/** The session facts the view renders at one moment. */
	snapshot: SessionSnapshot;
}>;

/**
 * Binds the Session Engine to React: it constructs one engine per mounted
 * session from the TUI-side ports, mirrors the Engine's Session Snapshot into
 * React state so the view re-renders, and forwards the session's commands. It
 * holds no session state: the Engine is the only writer, and every fact this
 * binding renders comes from a snapshot.
 *
 * The snapshot is mirrored through a subscription rather than
 * `useSyncExternalStore`: the synchronous re-render that hook performs inside
 * the submit path stalls the automatic-compaction journey in the OpenTUI test
 * renderer (`useSyncExternalStore` does receive updates in this renderer in
 * isolation, so this is about that interaction, not about the renderer dropping
 * notifications). The binding re-reads the snapshot once after subscribing, so
 * a change between render and effect is not lost.
 */
export function useSessionEngine(
	sessionId: SessionId,
	initialTranscript: SessionMessage[],
	initialContext: SessionMessage[] = initialTranscript,
	initialCompactions: SessionCompaction[] = []
): SessionEngineBinding {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const registry = useAgentRegistry();
	const toolPermission = useToolPermission();
	const { getCompactionSettings } = useCompactionSettings();
	const { project: projectApprovalPanels } = useApprovalPanels();
	// The ports read the current capability on every call: a session outlives
	// the render that supplied its connections, config, or registry.
	const connectionsRef = useLatest(connections);
	const mcpRef = useLatest(mcp);
	const configRef = useLatest(config);
	const registryRef = useLatest(registry);
	const toolPermissionRef = useLatest(toolPermission);
	const getCompactionSettingsRef = useLatest(getCompactionSettings);
	const summaryGenerator = useMemo(
		() => createDirectSummaryGenerator(connections),
		[connections]
	);
	const compactionModule = useMemo(
		() =>
			createSessionCompaction({
				attachmentStore: getSessionStore().attachmentStore,
				estimateTokens: (messages) => estimateCompactionTokens(messages),
				store: getSessionStore(),
				summaryGenerator,
			}),
		[summaryGenerator]
	);
	const compactionModuleRef = useLatest(compactionModule);
	const [engine] = useState<SessionEngine>(() => {
		const host = createSessionEngineHost({
			getCompactionModule: () => compactionModuleRef.current,
			getCompactionSettings: (model) => getCompactionSettingsRef.current(model),
			getConfig: () => configRef.current,
			getConnections: () => connectionsRef.current,
			getMcp: () => mcpRef.current,
			getRegistry: () => registryRef.current,
			getToolPermission: () => toolPermissionRef.current,
			sessionId,
		});
		const created = createSessionEngine({
			initialCompactions,
			initialContext,
			initialTranscript,
			ports: host.ports,
			sessionId,
		});
		host.attach(created);
		return created;
	});
	const [snapshot, setSnapshot] = useState(engine.getSnapshot);
	useEffect(() => {
		setSnapshot(engine.getSnapshot());
		return engine.subscribe(() => setSnapshot(engine.getSnapshot()));
	}, [engine]);
	// The panel surface reads the Engine's approvals; the binding only projects
	// them, and never reads a settlement back out of it.
	const approvalEntries = useMemo(
		() => projectSessionApprovals(snapshot.approvals, engine.respondToApproval),
		[engine.respondToApproval, snapshot.approvals]
	);
	useEffect(() => {
		projectApprovalPanels(approvalEntries);
	}, [approvalEntries, projectApprovalPanels]);
	useEffect(
		() => () => {
			// The session is going away: its send stops, every request it owns
			// settles, and the projection clears, so nothing waits on a panel that
			// no longer exists.
			engine.shutdown();
			projectApprovalPanels([]);
		},
		[engine, projectApprovalPanels]
	);
	const compact = useMemo(
		() =>
			(
				focus: string | undefined,
				selection: ChatModelSelection,
				selectionVariant?: ModelVariant
			) =>
				engine.compact({
					focus,
					model: selection,
					trigger: "manual",
					...omitUndefined({ variant: selectionVariant }),
				}),
		[engine]
	);

	return {
		cancel: engine.cancel,
		cancelCompaction: engine.cancelCompaction,
		compact,
		interrupt: engine.interrupt,
		recallQueuedSubmissions: engine.recallQueuedSubmissions,
		send: engine.send,
		snapshot,
	};
}
