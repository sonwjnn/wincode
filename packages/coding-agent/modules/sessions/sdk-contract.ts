import type {
	AgentId,
	AgentTurnEvent,
	AgentTurnId,
	SessionMessageId,
	SubmissionId,
} from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import type { SessionId } from "../../shared/identifiers";

/** Model-visible tool names a child Session is permitted to invoke. */
export type SessionSdkCapabilityCeiling = Readonly<{
	tools: readonly string[];
}>;

export type SessionSdkPrompt = Readonly<{
	agent?: AgentId | string;
	effort?: Effort;
	model?: ChatModelSelection;
	reasoningMode?: ReasoningMode;
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
	effort?: Effort;
	initialPrompt?: string;
	model?: ChatModelSelection;
	reasoningMode?: ReasoningMode;
}>;

export type SessionSdkAgent = Readonly<{
	id: AgentId;
	isAvailable: boolean;
	role: string;
}>;

export type SessionSdkSubmissionAdmission =
	| { readonly rejected: true; readonly reason: string }
	| {
			readonly rejected: false;
			readonly disposition: "started" | "queued";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId?: AgentTurnId;
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

export type SessionSdkInterruptResult = Readonly<{
	kind: "turn" | "compaction" | "none";
	recalled: readonly object[];
}>;

/** Stable, public fields exposed when observing a live Session. */
export type SessionSdkSnapshot = Readonly<{
	context: readonly object[];
	transcript: readonly object[];
	turnActive: boolean;
}>;

export type SessionSdkHandle = Readonly<{
	continue: () => SessionSdkContinuationOutcome;
	dispose: () => Promise<void>;
	interrupt: () => Promise<SessionSdkInterruptResult>;
	/** Queues FIFO input, starts an idle Session, and resolves after its Session Record commits. */
	deliver: (
		input: SessionSdkDelivery
	) => Promise<SessionSdkSubmissionAdmission>;
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	prompt: (input: SessionSdkPrompt) => Promise<SessionSdkSubmissionAdmission>;
	sessionId: SessionId;
	subscribe: (listener: (snapshot: SessionSdkSnapshot) => void) => () => void;
}>;

export type SessionSdk = Readonly<{
	createChildSdk: (
		options: Readonly<{
			capabilityCeiling?: SessionSdkCapabilityCeiling;
			pluginPaths?: readonly string[];
			projectTrust?: "trust" | "deny";
		}>
	) => Promise<SessionSdk>;
	createEmptySession: (options?: SessionSdkCreateOptions) => Promise<SessionId>;
	getAgentCatalog: () => Promise<readonly SessionSdkAgent[]>;
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

export type SessionSdkChildFactory = Pick<
	SessionSdk,
	| "createChildSdk"
	| "createEmptySession"
	| "deliverToSession"
	| "getAgentCatalog"
	| "openSession"
>;
