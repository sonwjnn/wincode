export type StartTuiInput = {
	args: readonly string[];
	cwd: string;
};

let runtimeContext: StartTuiInput | undefined;

export const setTuiRuntimeContext = (context: StartTuiInput): void => {
	runtimeContext = Object.freeze({ ...context, args: [...context.args] });
};

export const getTuiRuntimeContext = (): StartTuiInput => {
	if (runtimeContext === undefined) {
		throw new Error("TUI runtime context was not initialized");
	}
	return runtimeContext;
};
