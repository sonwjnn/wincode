import type { AgentId } from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai/models";
import type { ProviderModelSelection } from "../providers/provider-model-selection";
import type { SessionSdkCapabilityCeiling } from "./sdk-contract";

/** Public options accepted by caller-owned Session SDK instances. */
export type SessionSdkOptions = Readonly<{
	agent?: AgentId | string;
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	cwd?: string;
	databasePath?: string;
	model?: ProviderModelSelection;
	pluginPaths?: readonly string[];
	projectTrust?: "trust" | "deny";
	thinkingLevel?: ThinkingLevel;
	workspace?: string;
}>;
