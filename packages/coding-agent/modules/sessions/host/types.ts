import type { AgentRuntime, AgentTurnEvent } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { McpSessionCapability } from "@/modules/mcp/capability";
import type { ToolPermissionRuntime } from "@/modules/permissions/tool-permission-runtime";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import type { AgentSession, LiveSessionSnapshot } from "../agent-session/types";
import type { SessionCompactionModule } from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import type {
	DelegationReportEnvelope,
	DelegationTask,
} from "../delegation/types";
import type { ResolvedSessionSelection } from "../selection";
import type { SessionStore } from "../storage/session-store";
export type SessionApprovalMode = "interactive" | "non-interactive";

/**
 * What one Session Host needs from the surface that constructed it, as lazy
 * getters rather than values: a session outlives the render that supplied its
 * connections, configuration, and catalogs, so a capability is read when the
 * work that needs it runs, not when the session opened. Nothing here is
 * React-shaped, so a plain Node process satisfies the same contract.
 */
export type SessionCapabilities = Readonly<{
	/** The Session Compaction module whose in-flight map owns admission. */
	getCompactionModule: () => SessionCompactionModule;
	/** Resolves the compaction settings one Model Target runs with. */
	getCompactionSettings: (
		model: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	getConfig: () => ConfigRuntime;
	getConnections: () => Connections;
	getMcp: () => McpSessionCapability;
	/** The Agent registry, which resolves only after the session opened. */
	getRegistry: () => AgentRegistry | null;
	/** The durable store this session's records, compactions, and attachments live in. */
	getStore: () => SessionStore;
	getToolPermission: () => ToolPermissionRuntime;
	/** Optional runtime factory for non-default application adapters and tests. */
	getRuntime?: () => AgentRuntime;
	getSessionHostManager: () => SessionHostManager;
	getPluginRuntime?: () => PluginRuntime;
	/**
	 * Approval settlement policy for surfaces without an interactive approval
	 * channel. Omitted means the historical interactive behavior.
	 */
	getApprovalMode?: () => SessionApprovalMode;
}>;

/**
 * One open session and the assembly that owns its lifetime. The consumer that
 * constructs a Host owns calling `shutdown`; the Host holds no session state,
 * so every observed fact comes from the Agent Session it assembled.
 */
export type SessionHost = Readonly<{
	agentSession: AgentSession;
	/**
	 * The Session Selection the session opened with — the last-used Agent,
	 * model, and reasoning choice, resolved against the live Agent registry — so a
	 * consumer runs the next turn with what the session was using. Null when no
	 * source carries a model.
	 */
	getSelection: () => ResolvedSessionSelection | null;
	getSnapshot: () => LiveSessionSnapshot;
	/**
	 * Observes Agent Turn Events the Agent Session emits, in order, terminal
	 * ones included: the stream a consumer renders without reading full Snapshots
	 * per token.
	 */
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	/** Ends the session and resolves after active durable cleanup completes. */
	shutdown: () => Promise<void>;
	/** Publishes a committed report; active Hosts queue follow-up, idle Hosts retain it. */
	publishDelegationReport: (report: DelegationReportEnvelope) => void;
	/** Notifies that session facts changed; no payload, as the Agent Session publishes. */
	subscribe: (listener: () => void) => () => void;
}>;
export type SessionHostManagerEvent =
	| Readonly<{
			event: AgentTurnEvent;
			sessionId: SessionId;
			type: "agent-turn-event";
	  }>
	| Readonly<{
			report?: DelegationReportEnvelope;
			task: DelegationTask;
			type: "delegation-task";
	  }>
	| Readonly<{
			pendingApprovalCount: number;
			sessionId: SessionId;
			type: "session-approval-notice";
	  }>;
export type SessionDelegationSession = Readonly<{
	capabilities: SessionCapabilities;
	sessionId: SessionId;
}>;

/** Ports that the session owner provides to an injected delegation runtime. */
export type SessionDelegationRuntimePorts = Readonly<{
	emitTaskEvent: (
		task: DelegationTask,
		report?: DelegationReportEnvelope
	) => void;
	requestHostUnload: (sessionId: SessionId) => void;
}>;

/** Neutral session-boundary contract implemented by the delegation runtime. */
export type SessionDelegationPort = Readonly<{
	activeTaskIds: () => readonly DelegationTaskId[];
	cancelActiveTasks: (
		sessions: readonly SessionDelegationSession[]
	) => Promise<void>;
	finishAllTasks: () => void;
	finishTask: (taskId: DelegationTaskId) => void;
	getTaskForChild: (
		store: SessionStore,
		childSessionId: SessionId
	) => Promise<DelegationTask | null>;
	hasActiveTasks: (
		store: SessionStore,
		parentSessionId: SessionId
	) => Promise<boolean>;
	isTaskActive: (
		store: SessionStore,
		taskId: DelegationTaskId
	) => Promise<boolean>;
	onHostClosed: (sessionId: SessionId) => void;
	onHostOpened: (sessionId: SessionId, host: SessionHost) => void;
	onHostOpening: (sessionId: SessionId) => void;
	publishTask: (
		task: DelegationTask,
		report?: DelegationReportEnvelope
	) => void;
	recoverStore: (store: SessionStore) => Promise<void>;
	registerTask: (task: DelegationTask) => void;
	waitForTasks: (
		store: SessionStore,
		parentSessionId: SessionId
	) => Promise<DelegationTask[]>;
}>;

/** The built-in application composition supplies the concrete runtime factory. */
export type SessionDelegationRuntimeFactory = (
	ports: SessionDelegationRuntimePorts
) => SessionDelegationPort;

export type SessionHostManager = Readonly<{
	delegation: SessionDelegationPort;
	onEvent: (listener: (event: SessionHostManagerEvent) => void) => () => void;
	openHost: (input: {
		capabilities: SessionCapabilities;
		executionMode?: ExecutionMode;
		sessionId: SessionId;
		view?: boolean;
	}) => Promise<SessionHost>;
	releaseView: (sessionId: SessionId) => Promise<void>;
	shutdownAll: () => Promise<void>;
}>;

export type SessionHostOptions = Readonly<{
	capabilities: SessionCapabilities;
	executionMode?: ExecutionMode;
	sessionId: SessionId;
}>;
