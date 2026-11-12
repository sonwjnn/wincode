import type { ProviderCollection, ProviderModel } from "@wincode/ai";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { CacheWarmingStatus } from "@/modules/prompt-cache/cache-warming";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import type { SessionId } from "@/shared/identifiers";
import type { AgentSession, LiveSessionSnapshot } from "../agent-session/types";
import type { SessionCompactionModule } from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import type { SessionContextEdit } from "../context-edits";
import type { TurnToolResolver } from "../hooks/runtime-turn";
import type { SessionSdkPluginProviderSource } from "../plugin-provider-source";
import type {
	SessionHistoryNavigationOutcome,
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "../sdk-contract";
import type { SessionSelection } from "../selection";
import type { SessionSdkEvent } from "../session-events";
import type { SessionHistoryNavigationRequest } from "../session-pagination-types";
import type {
	SessionForkCheckpoint,
	SessionForkResult,
	SessionStore,
	SessionUsageEntry,
} from "../storage/session-store";
/**
 * What one Session Host needs from the surface that constructed it, as lazy
 * getters rather than values: a session outlives the render that supplied its
 * Provider composition and configuration, so a capability is read when the
 * work that needs it runs, not when the session opened. Nothing here is
 * React-shaped, so a plain Node process satisfies the same contract.
 */
export type SessionCapabilities = Readonly<{
	/** The Session Compaction module whose in-flight map owns admission. */
	getCompactionModule: () => SessionCompactionModule;
	/** Resolves the compaction settings for one selected Provider Model. */
	getCompactionSettings: (
		model: ProviderModelSelection,
		providerModel?: ProviderModel | null
	) => Promise<ResolvedCompactionSettings>;
	getConfig: () => ConfigRuntime;
	/** Creates a Host-owned ProviderCollection when this Host uses the SDK path. */
	createProviderCollection?: (
		pluginRuntime?: PluginRuntime,
		sessionId?: string,
		allowedPluginProviderIds?: readonly string[],
		allowedPluginProviderSources?: readonly SessionSdkPluginProviderSource[]
	) => ProviderCollection | undefined | Promise<ProviderCollection | undefined>;
	/** The Agent registry, which resolves only after the session opened. */
	getRegistry: () => AgentRegistry | null;
	/** The durable store this session's records, compactions, and attachments live in. */
	getStore: () => SessionStore;
	getSessionHostManager: () => SessionHostManager;
	getSessionSdk?: () => SessionSdkOperations | undefined;
	getPluginRuntime?: () => PluginRuntime;
	getTurnToolResolver?: () => TurnToolResolver;
	getCapabilityCeiling: () => SessionSdkCapabilityCeiling | undefined;
}>;

/** The capabilities read while running one Agent Turn. */
export type TurnRunnerCapabilities = Pick<
	SessionCapabilities,
	| "getCapabilityCeiling"
	| "getConfig"
	| "getPluginRuntime"
	| "getRegistry"
	| "getSessionSdk"
	| "getStore"
	| "getTurnToolResolver"
>;

/** The trusted Plugin runtime read while validating a selected Plugin Provider. */
export type PluginTrustCapabilities = Pick<
	SessionCapabilities,
	"getPluginRuntime"
>;

/** The Plugin runtime and factory needed to create and validate a ProviderCollection. */
export type ProviderCollectionCapabilities = Pick<
	SessionCapabilities,
	"createProviderCollection" | "getPluginRuntime"
>;

/** The capabilities used by Agent Session adapters and their composed turn runner. */
export type SessionAdapterCapabilities = Pick<
	SessionCapabilities,
	| "getCapabilityCeiling"
	| "getCompactionModule"
	| "getCompactionSettings"
	| "getConfig"
	| "getPluginRuntime"
	| "getRegistry"
	| "getSessionSdk"
	| "getStore"
	| "getTurnToolResolver"
>;

/** The durable store used to project a Session's initial state. */
export type SessionStoreCapabilities = Pick<SessionCapabilities, "getStore">;

/** The Session Host Manager's preflight dependencies for a Provider selection. */
export type HostManagerSelectionCapabilities = Pick<
	SessionCapabilities,
	"getPluginRuntime" | "getRegistry" | "getStore"
>;

/**
 * One open session and the assembly that owns its lifetime. The consumer that
 * constructs a Host owns calling `shutdown`; the Host holds no session state,
 * so every observed fact comes from the Agent Session it assembled.
 */
export type SessionHost = Readonly<{
	/** Called only while the manager holds the Session's idle mutation gate. */
	editContext: (edit: SessionContextEdit) => Promise<void>;
	/** Selects a history entry while the manager holds the idle gate. */
	navigateHistory: (
		request: SessionHistoryNavigationRequest
	) => Promise<SessionHistoryNavigationOutcome>;
	/** Blocks new work after a committed write leaves Session storage unresolved. */
	reportStorageError: (error: Error) => void;
	/** Blocks new work when a committed path cannot be restored safely. */
	blockExecution: (error: Error) => void;
	agentSession: AgentSession;
	/** Forks while reusing this Host's held source writer; call through the manager's fork gate. */
	forkSession: (
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<SessionForkResult>;
	/** Holds a reload-blocking lease across Host preflight and Session work admission. */
	withSessionWork: <Result>(
		action: () => Promise<Result>,
		onRejected: (reason: string) => Result
	) => Promise<Result>;
	/** Revalidates the complete trusted Plugin snapshot before Session side effects. */
	assertCurrentPluginProviderRegistrationSnapshot: () => void;
	providerCollection?: ProviderCollection;
	providerController?: InteractiveProviderController;
	/** Prepares a fresh Plugin Provider composition while the Host is idle. */
	prepareProviderComposition?: (
		pluginRuntime: PluginRuntime,
		options?: Readonly<{ includePluginProviders?: boolean }>
	) => Promise<PreparedSessionProviderComposition>;
	failProviderCompositionClosed?: () => Promise<void>;
	/**
	 * The Session Selection the session opened with — the last-used Agent,
	 * model, and reasoning choice, resolved against the live Agent registry — so a
	 * consumer runs the next turn with what the session was using. Null when no
	 * source carries a model.
	 */
	getSelection: () => SessionSelection | null;
	getSnapshot: () => LiveSessionSnapshot;
	getCacheWarmingStatus: () => CacheWarmingStatus;
	/** Cancels scheduled/in-flight warming after its Provider Model changes. */
	cancelCacheWarming: () => void;
	getSessionUsageEntries: () => readonly SessionUsageEntry[];
	/** Whether an imported Session still requires explicit local activation. */
	isImportedSessionActivationPending: () => boolean;
	/** Durably records explicit local activation before imported work may continue. */
	activateImportedSession: () => Promise<void>;
	/**
	 * Observes Session SDK and Agent Turn Events in order without requiring a
	 * full Snapshot for every streamed token.
	 */
	onEvent: (listener: (event: SessionSdkEvent) => void) => () => void;
	/** Ends the session and resolves after active durable cleanup completes. */
	shutdown: () => Promise<void>;
	/** Notifies that session facts changed; no payload, as the Agent Session publishes. */
	subscribe: (listener: () => void) => () => void;
}>;

export type PreparedSessionProviderComposition = Readonly<{
	commit: () => Promise<void>;
	discard: () => Promise<void>;
}>;

export type SessionHostManagerEvent = Readonly<{
	event: SessionSdkEvent;
	sessionId: SessionId;
	type: "session-event";
}>;

export type SessionWorkAdmission =
	| Readonly<{ kind: "admitted"; release: () => void }>
	| Readonly<{ kind: "rejected"; reason: string }>;

export type SessionLifecycleContext = Readonly<{
	existingHostWriter: boolean;
}>;

export type SessionHostManager = Readonly<{
	assertIdleForReload: () => Promise<void>;
	tryAcquireSessionWork: (sessionId?: SessionId) => SessionWorkAdmission;
	withIdleForSessionLifecycle: <Result>(
		sessionId: SessionId,
		action: (context: SessionLifecycleContext) => Promise<Result>,
		operation?: "delete" | "export"
	) => Promise<Result>;
	withIdleForSessionFork: <Result>(
		sessionId: SessionId,
		action: (host: SessionHost | undefined) => Promise<Result>
	) => Promise<Result>;
	withIdleForSessionContextEdit: <Result>(
		sessionId: SessionId,
		action: (host: SessionHost | undefined) => Promise<Result>
	) => Promise<Result>;
	withIdleForSessionNavigation: (
		sessionId: SessionId,
		request: SessionHistoryNavigationRequest,
		action: (
			host: SessionHost | undefined
		) => Promise<SessionHistoryNavigationOutcome>
	) => Promise<SessionHistoryNavigationOutcome>;
	withIdleForSessionDataReset: <Result>(
		action: () => Promise<Result>
	) => Promise<Result>;
	withIdleForReload: <Result>(action: () => Promise<Result>) => Promise<Result>;
	/** Rebind open Plugin Session scopes and idle Provider compositions. */
	replacePluginRuntime: (
		runtime: PluginRuntime,
		options?: Readonly<{ trustChanged?: boolean }>
	) => Promise<void>;
	onEvent: (listener: (event: SessionHostManagerEvent) => void) => () => void;
	openHost: (input: {
		autoContinue?: boolean;
		capabilities: SessionCapabilities;
		providerCollection?: ProviderCollection;
		executionMode?: ExecutionMode;
		providerModel?: ProviderModelSelection;
		agentPinSelection?: ProviderModelSelection;
		sessionId: SessionId;
		view?: boolean;
	}) => Promise<SessionHost>;
	releaseView: (sessionId: SessionId) => Promise<void>;
	shutdownAll: () => Promise<void>;
}>;

export type SessionHostOptions = Readonly<{
	autoContinue?: boolean;
	capabilities: SessionCapabilities;
	providerCollection?: ProviderCollection;
	executionMode?: ExecutionMode;
	providerModel?: ProviderModelSelection;
	sessionId: SessionId;
}>;
