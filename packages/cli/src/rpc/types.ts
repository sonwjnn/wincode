import type {
	AgentTurnId,
	ChatModelSelection,
	ModelVariant,
	SessionCapabilities,
	SessionCapabilitiesAssembly,
	SessionHost,
	SessionMessage,
	SessionMessageMetadata,
	SessionStore,
} from "@wincode/tui/session-rpc";
import type { JsonlInput } from "./protocol";

export const APPLICATION_ERROR_CODE = -32_000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const OUTPUT_DRAIN_TIMEOUT_MS = 5000;
export const DEFAULT_TRANSCRIPT_LIMIT = 100;
export const MAX_TRANSCRIPT_LIMIT = 500;
export const SERVER_VERSION = "0.1.0";
export const SESSION_RPC_METHODS = new Set([
	"session/create",
	"session/open",
	"session/submit",
	"session/interrupt",
	"session/recall",
	"session/getState",
	"session/getTranscript",
	"session/respondToApproval",
]);
export const AGENT_EVENT_TYPES = new Set([
	"agent-turn-started",
	"model-step-started",
	"text-delta",
	"reasoning-delta",
	"model-step-finished",
	"tool-call-started",
	"tool-call-finished",
	"agent-turn-completed",
	"agent-turn-failed",
	"agent-turn-cancelled",
	"agent-turn-interrupted",
]);
export const SESSION_TOOL_PART_TYPES = new Set([
	"tool-read",
	"tool-write",
	"tool-edit",
	"tool-recover",
	"tool-glob",
	"tool-grep",
	"tool-shell",
	"tool-delegate",
	"tool-skill",
]);

export type OutputWriter = {
	onError?: (listener: (error: unknown) => void) => () => void;
	write: (text: string) => boolean | undefined;
	drain?: () => Promise<void>;
};

export type RpcAssembly = Omit<
	SessionCapabilitiesAssembly,
	"store" | "workspaceId"
> & {
	store?: SessionStore;
	workspaceId: string;
};

export type RpcCompositionInput = Readonly<{
	cwd: string;
	workspace: string;
}>;

export type RpcRunnerOptions = Readonly<{
	composeCapabilities?: (input: RpcCompositionInput) => Promise<RpcAssembly>;
	input: JsonlInput;
	signal?: AbortSignal;
	signalExitCode?: number | (() => number);
	stderr: OutputWriter;
	stdout: OutputWriter;
}>;

export type Selection = Readonly<{
	agentId: string;
	model: ChatModelSelection;
	variant?: ModelVariant;
}>;

export type RuntimeModules = Readonly<{
	createAgentTurnId: () => AgentTurnId;
	createSessionHost: (input: {
		capabilities: SessionCapabilities;
		sessionId: string;
	}) => Promise<SessionHost>;
	createSessionCapabilities: (
		input: RpcCompositionInput
	) => Promise<RpcAssembly>;
	createSessionUserMessage: (
		text: string,
		metadata?: SessionMessageMetadata
	) => SessionMessage;
	modelSelectionSchema: {
		safeParse: (value: unknown) => {
			success: boolean;
			data?: ChatModelSelection;
		};
	};
	normalizeModelVariant: (
		selection: ChatModelSelection,
		variant: ModelVariant | undefined
	) => ModelVariant | undefined;
	isSupportedModelVariant: (
		selection: ChatModelSelection,
		variant: ModelVariant
	) => boolean;
	resolveWorkspaceRoot: (start: string) => string;
	toSessionId: (value: string) => string;
}>;

export type WireValue =
	| null
	| boolean
	| number
	| string
	| readonly WireValue[]
	| { readonly [key: string]: WireValue };

export type ApplicationFailure = Readonly<{
	code: string;
	data?: Record<string, unknown>;
	message: string;
}>;

export class RpcApplicationError extends Error {
	readonly code: string;
	readonly data?: Record<string, unknown>;

	constructor(failureInput: ApplicationFailure) {
		super(failureInput.message);
		this.name = "RpcApplicationError";
		this.code = failureInput.code;
		this.data = failureInput.data;
	}
}

export class RpcOutputOverflowError extends Error {
	constructor() {
		super("RPC output exceeded the 16 MiB limit.");
		this.name = "RpcOutputOverflowError";
	}
}

export class RpcProtocolError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "RpcProtocolError";
		this.code = code;
	}
}

export type RpcLifecycle =
	| "uninitialized"
	| "initialized"
	| "bound"
	| "closing"
	| "closed";

export type RpcSessionState = {
	lifecycle: RpcLifecycle;
	assembly?: RpcAssembly;
	host?: SessionHost;
	boundSessionId?: string;
	signalRequested: boolean;
	shutdownRequested: boolean;
};
