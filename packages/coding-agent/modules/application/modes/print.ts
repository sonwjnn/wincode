import { runPrintMode as runOneShotPrint } from "./one-shot";
import type { ApplicationContext } from "./types";

export const runPrintExecutionMode = (
	context: ApplicationContext
): Promise<number> => runOneShotPrint(context);
