import { buildAgent, planAgent } from "./agents";
import type { ModeType } from "./modes";

export const baseCodingAgentInstructions = `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.`;

const modeInstructions = {
	build: buildAgent.instructions,
	plan: planAgent.instructions,
} satisfies Record<ModeType, string>;

/** @deprecated Use resolved Agent instructions instead of a mode lookup. */
export const getModeInstructions = (mode: ModeType) => modeInstructions[mode];

export const getSystemInstructionsForAgent = (agentInstructions: string) =>
	`${baseCodingAgentInstructions}\n\n${agentInstructions}`;

/** @deprecated Use getSystemInstructionsForAgent with resolved Agent instructions. */
export const getSystemInstructions = (modeValue: ModeType) =>
	getSystemInstructionsForAgent(getModeInstructions(modeValue));
