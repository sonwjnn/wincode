import { type CodingAgentModeName, getCodingMode } from "./modes";

export const baseCodingAgentInstructions = `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.`;

export const getSystemInstructions = (modeName: CodingAgentModeName) => {
	const mode = getCodingMode(modeName);

	return `${baseCodingAgentInstructions}\n\n${mode.instructions}`;
};
