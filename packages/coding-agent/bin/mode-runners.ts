import type {
	DispatchModeLoader,
	DispatchModeRunners,
} from "../modules/application/dispatch";
import { runJsonExecutionMode } from "../modules/application/modes/json";
import { runPrintExecutionMode } from "../modules/application/modes/print";
import { runRpcExecutionMode } from "../modules/application/modes/rpc";
import type { ApplicationContext } from "../modules/application/modes/types";
import type {
	ProjectTrustChoice,
	ProjectTrustPromptRequest,
} from "../modules/project-trust/project-trust";
import type { ExecutionMode } from "../shared/execution-mode";
import { setInteractiveRuntimeContext } from "../shared/runtime-context";
import {
	createInteractiveRendererSession,
	type InteractiveRendererFactory,
	type InteractiveRendererSession,
} from "../tui/interactive-renderer-session";

type InteractiveModeRunner = Readonly<{
	promptProjectTrust: (
		request: ProjectTrustPromptRequest,
		session: InteractiveRendererSession
	) => Promise<ProjectTrustChoice>;
	rendererFactory?: InteractiveRendererFactory;
	runInteractive: (session: InteractiveRendererSession) => Promise<number>;
}>;

export const createModeRunnerLoader =
	(interactiveModeRunner?: InteractiveModeRunner): DispatchModeLoader =>
	async (mode: ExecutionMode): Promise<DispatchModeRunners> => {
		const baseRunners: DispatchModeRunners = {
			interactive: async () => {
				throw new Error(
					"Interactive mode must use its dedicated CLI entrypoint."
				);
			},
			json: runJsonExecutionMode,
			print: runPrintExecutionMode,
			rpc: runRpcExecutionMode,
		};
		if (mode !== "interactive" || interactiveModeRunner === undefined) {
			return baseRunners;
		}

		const session = await createInteractiveRendererSession(
			interactiveModeRunner.rendererFactory
		);
		return {
			...baseRunners,
			promptProjectTrust: (request) =>
				interactiveModeRunner.promptProjectTrust(request, session),
			cleanup: session.destroy,
			interactive: async (context: ApplicationContext) => {
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
					...(context.sessionTrustDecision === undefined
						? {}
						: { sessionTrustDecision: context.sessionTrustDecision }),
					...(context.startupDiagnostics === undefined
						? {}
						: { startupDiagnostics: context.startupDiagnostics }),
				});
				return interactiveModeRunner.runInteractive(session);
			},
		};
	};
