import type {
	AgentId,
	AgentTurnEvent,
	SubmissionId,
} from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import type { SessionId } from "@/shared/identifiers";
import type {
	LiveSessionSnapshot,
	SessionContinuationOutcome,
	SessionInterruptResult,
	SessionSubmissionAdmission,
} from "./agent-session/types";

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

export type SessionSdkHandle = Readonly<{
	continue: () => SessionContinuationOutcome;
	dispose: () => Promise<void>;
	interrupt: () => Promise<SessionInterruptResult>;
	/** Queues FIFO input, starts an idle Session, and resolves after its Session Record commits. */
	deliver: (input: SessionSdkDelivery) => Promise<SessionSubmissionAdmission>;
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	prompt: (input: SessionSdkPrompt) => Promise<SessionSubmissionAdmission>;
	sessionId: SessionId;
	subscribe: (listener: (snapshot: LiveSessionSnapshot) => void) => () => void;
}>;

export type SessionSdk = Readonly<{
	createChildSdk: (
		options: Readonly<{
			capabilityCeiling?: SessionSdkCapabilityCeiling;
			enabledPlugins: readonly ("mcp" | "subagents")[];
			pluginPaths?: readonly string[];
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
	) => Promise<SessionSubmissionAdmission>;
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
