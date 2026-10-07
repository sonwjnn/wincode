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
	SessionSubmissionAdmission,
} from "./agent-session/types";

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

export type SessionSdkHandle = Readonly<{
	continue: () => SessionContinuationOutcome;
	dispose: () => Promise<void>;
	/** Durably queues a message and wakes this Session at its next safe boundary. */
	deliver: (input: SessionSdkDelivery) => Promise<SessionSubmissionAdmission>;
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	prompt: (input: SessionSdkPrompt) => Promise<SessionSubmissionAdmission>;
	sessionId: SessionId;
	subscribe: (listener: (snapshot: LiveSessionSnapshot) => void) => () => void;
}>;

export type SessionSdk = Readonly<{
	createChildSdk: (
		options: Readonly<{
			enabledPlugins: readonly ("mcp" | "subagents")[];
			pluginPaths?: readonly string[];
		}>
	) => Promise<SessionSdk>;
	createEmptySession: (options?: SessionSdkCreateOptions) => Promise<SessionId>;
	createSession: (
		options?: SessionSdkCreateOptions
	) => Promise<SessionSdkHandle>;
	dispose: () => Promise<void>;
	openSession: (
		sessionId: SessionId | string,
		options?: Readonly<{ view?: boolean }>
	) => Promise<SessionSdkHandle>;
}>;

export type SessionSdkChildFactory = Pick<SessionSdk, "createChildSdk">;
