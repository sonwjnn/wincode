import { z } from "zod";
import { buildAgent, planAgent, resolvedAgentRuntimeSchema } from "./agents";
import { mcpToolManifestSchema } from "./mcp-tools";
import { supportedChatModelIdSchema } from "./models";
import type { CodingToolName } from "./tools/schemas";

type CodingModeShape = {
	description: string;
	displayName: string;
	tools: readonly CodingToolName[];
	value: string;
};

/** @deprecated Temporary compatibility adapter while consumers migrate to Agents. */
export const codingModes = [
	{
		description: buildAgent.description,
		displayName: buildAgent.displayName,
		tools: buildAgent.visibleCodingTools,
		value: buildAgent.id,
	},
	{
		description: planAgent.description,
		displayName: planAgent.displayName,
		tools: planAgent.visibleCodingTools,
		value: planAgent.id,
	},
] as const satisfies readonly CodingModeShape[];

/** @deprecated Temporary compatibility alias while consumers migrate to AgentId. */
export type ModeType = (typeof codingModes)[number]["value"];

/** @deprecated Temporary compatibility shape while consumers migrate to Agents. */
export type CodingModeDefinition = {
	description: string;
	displayName: string;
	tools: readonly CodingToolName[];
	value: ModeType;
};

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const codingModeNames = codingModes.map((mode) => mode.value);
/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const codingModeNameSchema = z.enum(codingModeNames);

export const codingAgentCallOptionsSchema = z.object({
	mode: codingModeNameSchema.optional(),
	model: supportedChatModelIdSchema.optional(),
	mcpTools: mcpToolManifestSchema.optional(),
	resolvedAgent: resolvedAgentRuntimeSchema.optional(),
});

export type CodingAgentCallOptions = z.infer<
	typeof codingAgentCallOptionsSchema
>;

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const defaultMode = codingModes[0];

/**
 * Maps a canonical Agent ID to the legacy Coding Mode it still represents.
 * Built-in Agents keep their identity; Configured Agents fall back to the
 * default mode so legacy consumers (hosted requests, persistence, MCP
 * snapshots) keep compiling until the mode to agent migration completes.
 * @deprecated Temporary compatibility helper while consumers migrate to Agent identity.
 */
export const getLegacyModeForAgent = (agentId: string): ModeType => {
	const parsed = codingModeNameSchema.safeParse(agentId);
	return parsed.success ? parsed.data : defaultMode.value;
};

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const parseMode = (value: string): ModeType => {
	const result = codingModeNameSchema.safeParse(value);
	return result.success ? result.data : defaultMode.value;
};

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const getCodingMode = (mode: ModeType): CodingModeDefinition =>
	codingModes.find((item) => item.value === mode) ?? defaultMode;

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const getNextCodingModeName = (mode: ModeType): ModeType => {
	const currentIndex = codingModes.findIndex((item) => item.value === mode);
	const nextIndex = (currentIndex + 1) % codingModes.length;
	return codingModes[nextIndex]?.value ?? defaultMode.value;
};

/** @deprecated Temporary compatibility API while consumers migrate to Agents. */
export const isCodingToolAllowedForMode = (
	mode: ModeType,
	toolName: CodingToolName
) => getCodingMode(mode).tools.includes(toolName);
