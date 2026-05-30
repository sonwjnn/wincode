import { getCodingMode, type ModeType } from "./modes";

export const baseCodingAgentInstructions = `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.`;

export const getSystemInstructions = (modeValue: ModeType) => {
	const mode = getCodingMode(modeValue);

	return `${baseCodingAgentInstructions}\n\n${mode.instructions}`;
};
