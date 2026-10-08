import type { AgentId } from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import type { SessionSdkCapabilityCeiling } from "./sdk-contract";

/** Public options accepted by caller-owned Session SDK instances. */
export type SessionSdkOptions = Readonly<{
	agent?: AgentId | string;
	approvalMode?: "interactive" | "non-interactive";
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	cwd?: string;
	databasePath?: string;
	effort?: Effort;
	model?: ChatModelSelection;
	pluginPaths?: readonly string[];
	reasoningMode?: ReasoningMode;
	workspace?: string;
}>;
