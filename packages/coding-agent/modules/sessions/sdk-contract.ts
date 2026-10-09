import type {
	AgentId,
	AgentTurnEvent,
	AgentTurnId,
	SessionMessageId,
	SubmissionId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ThinkingLevel } from "@wincode/ai/models";
import type { SessionId } from "../../shared/identifiers";

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
	model?: ChatModelSelection;
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
	model?: ChatModelSelection;
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
	model?: ChatModelSelection;
	thinkingLevel?: ThinkingLevel;
	role: string;
	source?: SessionSdkAgentSource;
	requiredTools?: readonly string[];
	unavailableReason?: string;
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

export type SessionRuntimeOptions = Readonly<{
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	pluginPaths?: readonly string[];
	projectTrust?: "trust" | "deny";
}>;

export type SessionSdk = Readonly<{
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
	| "createSessionRuntime"
	| "createEmptySession"
	| "deliverToSession"
	| "getAgentCatalog"
	| "openSession"
>;
