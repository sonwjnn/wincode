import type {
	DispatchModeLoader,
	DispatchModeRunners,
} from "../modules/application/dispatch";
import { runJsonExecutionMode } from "../modules/application/modes/json";
import { runPrintExecutionMode } from "../modules/application/modes/print";
import { runRpcExecutionMode } from "../modules/application/modes/rpc";
import type { ApplicationContext } from "../modules/application/modes/types";
import type { ProjectTrustPrompt } from "../modules/project-trust/project-trust";
import type { ExecutionMode } from "../shared/execution-mode";
import { setInteractiveRuntimeContext } from "../shared/runtime-context";

type InteractiveModeRunner = Readonly<{
	promptProjectTrust: ProjectTrustPrompt;
	runInteractive: () => Promise<number>;
}>;

export const createModeRunnerLoader =
	(interactiveModeRunner?: InteractiveModeRunner): DispatchModeLoader =>
	async (mode: ExecutionMode): Promise<DispatchModeRunners> => ({
		...(mode === "interactive" && interactiveModeRunner !== undefined
			? { promptProjectTrust: interactiveModeRunner.promptProjectTrust }
			: {}),
		interactive: async (context: ApplicationContext) => {
			if (interactiveModeRunner === undefined) {
				throw new Error(
					"Interactive mode must use its dedicated CLI entrypoint."
				);
			}
			setInteractiveRuntimeContext({
				args: context.args,
				cwd: context.cwd,
				...(context.configRuntime === undefined
					? {}
					: { configRuntime: context.configRuntime }),
				...(context.pluginRuntime === undefined
					? {}
					: { pluginRuntime: context.pluginRuntime }),
				...(context.resourceLoader === undefined
					? {}
					: { resourceLoader: context.resourceLoader }),
			});
			return interactiveModeRunner.runInteractive();
		},
		json: runJsonExecutionMode,
		print: runPrintExecutionMode,
		rpc: runRpcExecutionMode,
	});
