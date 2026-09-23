import type { AgentRuntime, AgentTurnEvent } from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { Connections } from "@/modules/connections/contract";
import type { McpSessionCapability } from "@/modules/mcp/capability";
import type { ToolPermissionRuntime } from "@/modules/permissions/tool-permission-runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { SessionId } from "@/shared/identifiers";
import type { SessionCompactionModule } from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import type { SessionEngine, SessionSnapshot } from "../engine/types";
import type { ResolvedSessionSelection } from "../selection";
import type { SessionStore } from "../storage/session-store";
export type SessionApprovalMode = "interactive" | "non-interactive";
export type SessionHostFailure = Readonly<{
	code: "session_lease_lost";
}>;

export type SessionLeaseScheduler = (
	callback: () => void,
	intervalMs: number
) => () => void;

export type SessionHostLeaseOptions = Readonly<{
	now?: () => number;
	schedule?: SessionLeaseScheduler;
}>;

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
	/**
	 * Approval settlement policy for surfaces without an interactive approval
	 * channel. Omitted means the historical interactive behavior.
	 */
	getApprovalMode?: () => SessionApprovalMode;
}>;

/**
 * One open session and the assembly that owns its lifetime. The consumer that
 * constructs a Host owns calling `shutdown`; a Host holds no session state of
 * its own, so every fact an observer reads comes from the Engine it assembled.
 */
export type SessionHost = Readonly<{
	engine: SessionEngine;
	/**
	 * The Session Selection the session opened with — the last-used Agent,
	 * model, and variant, resolved against the live Agent registry — so a
	 * consumer runs the next turn with what the session was using. Null when no
	 * source carries a model.
	 */
	getSelection: () => ResolvedSessionSelection | null;
	getSnapshot: () => SessionSnapshot;
	/** Reports a fatal Host lifecycle failure, such as losing its Session Lease. */
	onFatal: (listener: (failure: SessionHostFailure) => void) => () => void;
	/**
	 * Observes the Agent Turn Events the Engine receives, in order, terminal
	 * ones included: the stream a consumer renders text and reasoning from
	 * without reading whole Snapshots per token.
	 */
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	/** Ends the session and resolves after active durable cleanup completes. */
	shutdown: () => Promise<void>;
	/** Notifies that session facts changed; no payload, as the Engine publishes. */
	subscribe: (listener: () => void) => () => void;
}>;

export type SessionHostOptions = Readonly<{
	capabilities: SessionCapabilities;
	sessionId: SessionId;
	lease?: SessionHostLeaseOptions;
}>;
