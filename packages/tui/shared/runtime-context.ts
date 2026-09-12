export type TuiRuntimeContext = {
	args: readonly string[];
	cwd: string;
};

let runtimeContext: TuiRuntimeContext | undefined;

export const setTuiRuntimeContext = (context: TuiRuntimeContext): void => {
	runtimeContext = Object.freeze({ ...context, args: [...context.args] });
};

export const getTuiRuntimeContext = (): TuiRuntimeContext => {
	if (runtimeContext === undefined) {
		throw new Error("TUI runtime context was not initialized");
	}
	return runtimeContext;
};
