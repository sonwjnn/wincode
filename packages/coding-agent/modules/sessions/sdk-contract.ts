import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	SubmissionId,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import type { SessionId } from "../../shared/identifiers";
import type { PluginFactory } from "../plugins/public";
import type { ProviderModelSelection } from "../providers/provider-model-selection";
import type { SessionContextEdit } from "./context-edits";
import type {
	SessionBundleExportOptions,
	SessionBundleExportResult,
	SessionBundleImportOptions,
	SessionBundleImportResult,
} from "./session-bundle-contract";
import type { SessionSdkEvent } from "./session-events";
import type {
	SessionCatalogPage,
	SessionHistoryPage,
	SessionHistoryTreePage,
	SessionPageOptions,
} from "./session-pagination-types";
import type {
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "./session-write-outcome";
import type {
	SessionForkCheckpoint,
	SessionForkResult,
} from "./storage/session-store";
import type {
	SessionStatistics,
	SessionStatisticsOptions,
} from "./usage/session-statistics";

export type { SessionContextEdit } from "./context-edits";
export type {
	SessionBundleAttachment,
	SessionBundleCut,
	SessionBundleExportOptions,
	SessionBundleExportResult,
	SessionBundleFile,
	SessionBundleImportOptions,
	SessionBundleImportResult,
	SessionBundleManifest,
} from "./session-bundle-contract";
export type {
	Session,
	SessionCatalogPage,
	SessionHistoryPage,
	SessionHistoryTreeEntry,
	SessionHistoryTreePage,
	SessionPageCompaction,
	SessionPageOptions,
} from "./session-pagination-types";
export type {
	SessionWriteFailure,
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "./session-write-outcome";
export type {
	SessionForkCheckpoint,
	SessionForkResult,
} from "./storage/session-store";
export type {
	SessionStatistics,
	SessionStatisticsOptions,
} from "./usage/session-statistics";

/** Model-visible tool names a child Session is permitted to invoke. */
export type SessionSdkCapabilityCeiling = Readonly<{
	tools: readonly string[];
}>;

export const snapshotSessionSdkCapabilityCeiling = (
	ceiling: SessionSdkCapabilityCeiling | undefined
): SessionSdkCapabilityCeiling | undefined => {
	if (ceiling === undefined) {
		return;
	}
	if (
		!Array.isArray(ceiling.tools) ||
		ceiling.tools.some(
			(tool) => typeof tool !== "string" || tool.trim().length === 0
		)
	) {
		throw new Error(
			"Session capability ceilings require non-empty tool names."
		);
	}
	return Object.freeze({ tools: Object.freeze([...ceiling.tools]) });
};

export type SessionSdkPrompt = Readonly<{
	agent?: AgentId | string;
	/** Hard ceiling on Provider chat requests for this prompt, including retries. */
	maximumModelSteps?: number;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
	submissionId?: SubmissionId;
	text: string;
}>;

export type SessionSdkDelivery = Readonly<{
	idempotencyKey: string;
	text: string;
}>;

export type SessionSdkCreateOptions = Readonly<{
	sessionId?: SessionId;
	agent?: AgentId | string;
	initialPrompt?: string;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

export type SessionSdkAgentSource =
	| "builtin"
	| "global"
	| "package"
	| "project"
	| "user";

export type SessionSdkAgent = Readonly<{
	description?: string;
	id: AgentId;
	isAvailable: boolean;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
	role: string;
	source?: SessionSdkAgentSource;
	requiredTools?: readonly string[];
	unavailableReason?: string;
}>;

export type SessionSdkSubmissionAdmission =
	| {
			readonly rejected: true;
			readonly reason: string;
			readonly code?: string;
			readonly writeOutcome?: SessionWriteOutcome;
	  }
	| {
			readonly rejected: false;
			readonly disposition: "started" | "queued";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId?: AgentTurnId;
			readonly writeOutcome?: SessionWriteOutcome;
	  }
	| {
			readonly rejected: false;
			readonly disposition: "duplicate";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly writeOutcome: SessionWriteReceipt;
	  };

export type SessionSdkContinuationOutcome =
	| { readonly kind: "rejected"; readonly reason: string }
	| { readonly kind: "resumed"; readonly turnId: AgentTurnId }
	| {
			readonly kind: "started-submission";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId?: AgentTurnId;
	  };

export type SessionHistoryNavigationOutcome =
	| {
			readonly kind: "navigated";
			readonly activeLeafId: string | null;
			readonly writeOutcome: SessionWriteReceipt;
	  }
	| {
			readonly kind: "unchanged";
			readonly activeLeafId: string | null;
	  }
	| {
			readonly kind: "rejected";
			readonly reason: string;
			readonly code?: string;
			readonly writeOutcome?: SessionWriteOutcome;
	  }
	| {
			readonly kind: "committed-blocked";
			readonly activeLeafId: string | null;
			readonly reason: string;
			readonly writeOutcome?: SessionWriteReceipt;
	  }
	| {
			readonly kind: "indeterminate";
			readonly reason: string;
			readonly writeOutcome: Extract<
				SessionWriteOutcome,
				{ kind: "indeterminate" }
			>;
	  };

export type SessionSdkInterruptResult = Readonly<{
	kind: "turn" | "compaction" | "none";
	recalled: readonly object[];
}>;

export type SessionSdkSnapshot = Readonly<{
	context: readonly object[];
	storageError: Readonly<{
		code: string;
		message: string;
		writeOutcome?: SessionWriteOutcome;
	}> | null;
	transcript: readonly object[];
	turnActive: boolean;
}>;

export type SessionSdkHandle = Readonly<{
	/** Appends an idle-only context edit without changing the original transcript. */
	editContext: (edit: SessionContextEdit) => Promise<void>;
	/** Selects any existing history entry (or the root) as the active leaf while idle. */
	navigateHistory: (
		targetEntryId: string | null,
		operationId: string
	) => Promise<SessionHistoryNavigationOutcome>;
	continue: () => Promise<SessionSdkContinuationOutcome>;
	fork: (
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<SessionSdkForkResult>;
	dispose: () => Promise<void>;
	interrupt: () => Promise<SessionSdkInterruptResult>;
	/** Queues FIFO input, starts an idle Session, and resolves after its Session Record commits. */
	deliver: (
		input: SessionSdkDelivery
	) => Promise<SessionSdkSubmissionAdmission>;
	onEvent: (listener: (event: SessionSdkEvent) => void) => () => void;
	prompt: (input: SessionSdkPrompt) => Promise<SessionSdkSubmissionAdmission>;
	sessionId: SessionId;
	subscribe: (listener: (snapshot: SessionSdkSnapshot) => void) => () => void;
}>;

export type SessionSdkForkResult = SessionForkResult &
	Readonly<{ handle: SessionSdkHandle }>;

export type SessionSdkPluginFactory = Readonly<{
	factory: PluginFactory;
	id: string;
}>;

export type SessionRuntimeOptions = Readonly<{
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	pluginFactories?: readonly SessionSdkPluginFactory[];
	pluginPaths?: readonly string[];
	pluginProviderIds?: readonly string[];
	projectTrust?: "trust" | "deny";
	sessionId?: SessionId | string;
}>;

export type SessionSdk = Readonly<{
	listSessionsPage: (
		options?: SessionPageOptions
	) => Promise<SessionCatalogPage>;
	readSessionHistoryPage: (
		sessionId: SessionId | string,
		options?: SessionPageOptions
	) => Promise<SessionHistoryPage>;
	readSessionHistoryTreePage: (
		sessionId: SessionId | string,
		options?: SessionPageOptions
	) => Promise<SessionHistoryTreePage>;
	navigateSessionHistory: (
		sessionId: SessionId | string,
		targetEntryId: string | null,
		operationId: string
	) => Promise<SessionHistoryNavigationOutcome>;
	getSessionStatistics: (
		sessionId: SessionId | string,
		options?: SessionStatisticsOptions
	) => Promise<SessionStatistics>;
	forkSession: (
		sessionId: SessionId | string,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<SessionSdkForkResult>;
	exportSessionBundle: (
		sessionId: SessionId | string,
		destination: string,
		options?: SessionBundleExportOptions
	) => Promise<SessionBundleExportResult>;
	/** Imports into this SDK's local workspace, keeping the Session activation-gated. */
	importSessionBundle: (
		bundlePath: string,
		options?: SessionBundleImportOptions
	) => Promise<SessionBundleImportResult>;
	createSessionRuntime: (
		options?: SessionRuntimeOptions
	) => Promise<SessionSdk>;
	createEmptySession: (options?: SessionSdkCreateOptions) => Promise<SessionId>;
	getAgentCatalog: (
		options?: Readonly<{ capabilityCeiling?: SessionSdkCapabilityCeiling }>
	) => Promise<readonly SessionSdkAgent[]>;
	createSession: (
		options?: SessionSdkCreateOptions
	) => Promise<SessionSdkHandle>;
	deliverToSession: (
		sessionId: SessionId | string,
		input: SessionSdkDelivery
	) => Promise<SessionSdkSubmissionAdmission>;
	dispose: () => Promise<void>;
	openSession: (
		sessionId: SessionId | string,
		options?: Readonly<{ autoContinue?: boolean; view?: boolean }>
	) => Promise<SessionSdkHandle>;
}>;

export type SessionSdkOperations = Pick<
	SessionSdk,
	| "listSessionsPage"
	| "readSessionHistoryPage"
	| "readSessionHistoryTreePage"
	| "navigateSessionHistory"
	| "getSessionStatistics"
	| "forkSession"
	| "exportSessionBundle"
	| "importSessionBundle"
	| "createSessionRuntime"
	| "createEmptySession"
	| "deliverToSession"
	| "getAgentCatalog"
	| "openSession"
>;
