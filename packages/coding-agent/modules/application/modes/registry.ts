import { runJsonExecutionMode } from "./json";
import { runPrintExecutionMode } from "./print";
import { runRpcExecutionMode } from "./rpc";
import type {
	ApplicationContext,
	ExecutionMode,
	ExecutionModeFactory,
} from "./types";

const factories: Readonly<Record<ExecutionMode, ExecutionModeFactory>> = {
	interactive: async (context) => {
		// Interactive Mode is the only factory that loads the OpenTUI/React graph.
		const { runInteractiveMode } = await import("./interactive");
		return runInteractiveMode(context);
	},
	json: runJsonExecutionMode,
	print: runPrintExecutionMode,
	rpc: runRpcExecutionMode,
};

export const executionModeRegistry = factories;

export const getExecutionModeFactory = (
	mode: ExecutionMode
): ExecutionModeFactory => factories[mode];

export const runExecutionMode = (
	mode: ExecutionMode,
	context: ApplicationContext
): Promise<number> => getExecutionModeFactory(mode)(context);
