import { z } from "zod";
import { supportedChatModelIdSchema } from "./models";
import type { CodingToolName } from "./tools/schemas";

type CodingModeShape = {
	description: string;
	displayName: string;
	tools: readonly CodingToolName[];
	value: string;
};

export const codingModes = [
	{
		description: "Implement changes with read and write access.",
		displayName: "Build",
		tools: ["read", "write", "edit", "list", "grep"],
		value: "build",
	},
	{
		description: "Read-only analysis and planning.",
		displayName: "Plan",
		tools: ["read", "list", "grep"],
		value: "plan",
	},
] as const satisfies readonly CodingModeShape[];

export type ModeType = (typeof codingModes)[number]["value"];

export type CodingModeDefinition = {
	description: string;
	displayName: string;
	tools: readonly CodingToolName[];
	value: ModeType;
};

export const codingModeNames = codingModes.map((mode) => mode.value);
export const codingModeNameSchema = z.enum(codingModeNames);

export const codingAgentCallOptionsSchema = z.object({
	mode: codingModeNameSchema.optional(),
	model: supportedChatModelIdSchema.optional(),
});

export type CodingAgentCallOptions = z.infer<
	typeof codingAgentCallOptionsSchema
>;

export const defaultMode = codingModes[0];

export const parseMode = (value: string): ModeType => {
	const result = codingModeNameSchema.safeParse(value);
	return result.success ? result.data : defaultMode.value;
};

export const getCodingMode = (mode: ModeType): CodingModeDefinition =>
	codingModes.find((item) => item.value === mode) ?? defaultMode;

export const getNextCodingModeName = (mode: ModeType): ModeType => {
	const currentIndex = codingModes.findIndex((item) => item.value === mode);
	const nextIndex = (currentIndex + 1) % codingModes.length;
	return codingModes[nextIndex]?.value ?? defaultMode.value;
};

export const isCodingToolAllowedForMode = (
	mode: ModeType,
	toolName: CodingToolName
) => getCodingMode(mode).tools.includes(toolName);
