import {
	type StartInteractiveInput,
	setInteractiveRuntimeContext,
} from "../../../shared/runtime-context";
import type { ApplicationContext } from "./types";

export const runInteractiveMode = async (
	context: ApplicationContext
): Promise<number> => {
	const input: StartInteractiveInput = {
		args: context.args,
		cwd: context.cwd,
	};
	setInteractiveRuntimeContext(input);
	// Interactive Mode is intentionally lazy so help/version stay OpenTUI-free.
	const { runInteractive } = await import("../../../app/runtime");
	return runInteractive();
};
