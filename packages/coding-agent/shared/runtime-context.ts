import { isUndefined } from "@wincode/runtime-utils";
export type StartInteractiveInput = {
	args: readonly string[];
	cwd: string;
};

let runtimeContext: StartInteractiveInput | undefined;

export const setInteractiveRuntimeContext = (
	context: StartInteractiveInput
): void => {
	runtimeContext = Object.freeze({ ...context, args: [...context.args] });
};

export const getInteractiveRuntimeContext = (): StartInteractiveInput => {
	if (isUndefined(runtimeContext)) {
		throw new Error("Interactive runtime context was not initialized");
	}
	return runtimeContext;
};
