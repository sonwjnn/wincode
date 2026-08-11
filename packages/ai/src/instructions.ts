export const baseCodingAgentInstructions = `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.`;

export const getSystemInstructionsForAgent = (agentInstructions: string) =>
	`${baseCodingAgentInstructions}\n\n${agentInstructions}`;
