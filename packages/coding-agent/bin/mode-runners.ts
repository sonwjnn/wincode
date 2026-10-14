import { omitUndefined } from "@wincode/utils";
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
	createRendererSession,
	type RendererFactory,
	type RendererSession,
} from "../tui/renderer-session";

type InteractiveModeRunner = Readonly<{
	promptProjectTrust: (
		request: ProjectTrustPromptRequest,
		session: RendererSession
	) => Promise<ProjectTrustChoice>;
	rendererFactory?: RendererFactory;
	runInteractive: (session: RendererSession) => Promise<number>;
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

		const session = await createRendererSession(
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
					...omitUndefined({
						configRuntime: context.configRuntime,
						pluginRuntime: context.pluginRuntime,
						resourceLoader: context.resourceLoader,
						sessionTrustDecision: context.sessionTrustDecision,
						startupDiagnostics: context.startupDiagnostics,
					}),
				});
				return interactiveModeRunner.runInteractive(session);
			},
		};
	};
