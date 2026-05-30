import { z } from "zod";
import type { CodingToolName } from "./tools/schemas";

export const codingModeNames = ["build", "plan"] as const;

export const codingModeNameSchema = z.enum(codingModeNames);

export const codingAgentCallOptionsSchema = z.object({
	mode: codingModeNameSchema.optional(),
});

export type CodingAgentModeName = (typeof codingModeNames)[number];

export type CodingAgentCallOptions = z.infer<
	typeof codingAgentCallOptionsSchema
>;

type CodingModeDefinition = {
	description: string;
	displayName: string;
	instructions: string;
	name: CodingAgentModeName;
	tools: readonly CodingToolName[];
};

export const codingModes = [
	{
		description: "Implement changes with read and write access.",
		displayName: "Build",
		instructions: `Mode: BUILD.
Purpose: implement requested code changes in the workspace.
Use tools to inspect and modify files before answering about code.
Prefer list, grep, and read before editing. Prefer edit for targeted changes and write for new files or full rewrites.`,
		name: "build",
		tools: ["read", "write", "edit", "list", "grep"],
	},
	{
		description: "Read-only analysis and planning.",
		displayName: "Plan",
		instructions: `Mode: PLAN.
Purpose: read-only analysis and implementation planning.
Do not modify files. Do not write files. Do not call edit or write tools.
Use only read-only inspection tools to understand the workspace.
Return a concrete plan, risks, and verification steps instead of implementing changes.`,
		name: "plan",
		tools: ["read", "list", "grep"],
	},
] as const satisfies readonly CodingModeDefinition[];

export const defaultCodingMode = codingModes[0];

export const getCodingMode = (
	modeName: CodingAgentModeName
): CodingModeDefinition =>
	codingModes.find((mode) => mode.name === modeName) ?? defaultCodingMode;

export const getNextCodingModeName = (
	modeName: CodingAgentModeName
): CodingAgentModeName => {
	const currentIndex = codingModes.findIndex((mode) => mode.name === modeName);
	const nextIndex = (currentIndex + 1) % codingModes.length;

	return codingModes[nextIndex]?.name ?? defaultCodingMode.name;
};

export const isCodingToolAllowedForMode = (
	modeName: CodingAgentModeName,
	toolName: CodingToolName
) => getCodingMode(modeName).tools.includes(toolName);
