import { runJsonMode as runOneShotJson } from "./one-shot";
import type { ApplicationContext } from "./types";

export const runJsonExecutionMode = (
	context: ApplicationContext
): Promise<number> => runOneShotJson(context);
