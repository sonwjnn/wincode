import { setTuiRuntimeContext } from "./shared/runtime-context";

export type StartTuiInput = {
	args: readonly string[];
	cwd: string;
};

export const getTuiHelpText = (): string =>
	["TUI options:", "  --auto    Enable automatic tool approval"].join("\n");
export const startTui = async (input: StartTuiInput): Promise<number> => {
	setTuiRuntimeContext(input);
	// The interactive graph must remain absent from CLI help and version paths.
	const { runTui } = await import("./runtime");
	return await runTui();
};
