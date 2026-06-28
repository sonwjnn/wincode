import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ThemeDialogContent } from "../../modules/appearance/ui/theme-dialog";
import {
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from "../../modules/commands/adapters";
import type { CommandSpec } from "../../modules/commands/commands";
import { createCommandExecutor } from "../../modules/commands/execute-command";
import { SessionsDialogContent } from "../../modules/conversations/ui/sessions/sessions-dialog";
import { usePromptConfig } from "../../modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "../../modules/prompt-settings/ui/agents-dialog";
import { ModelsDialogContent } from "../../modules/prompt-settings/ui/models-dialog";
import { useDialog } from "../../shared/terminal/dialog/dialog-provider";
import { useToast } from "../../shared/terminal/toast/toast-provider";

type UseCommandExecutorReturn = {
	executeCommand: (spec: CommandSpec) => Promise<void>;
};

export function useCommandExecutor(): UseCommandExecutorReturn {
	const renderer = useRenderer();
	const router = useRouter();
	const dialog = useDialog();
	const toast = useToast();
	const { mode, model, setMode, setModel } = usePromptConfig();

	const execute = useMemo(
		() =>
			createCommandExecutor({
				exit: new ExitAdapter({ destroy: () => renderer.destroy() }),
				new: new NewAdapter({
					navigateHome: () => {
						router.navigate({ to: "/" }).catch(() => undefined);
					},
				}),
				dialog: new DialogAdapter({
					open: (key, title) => {
						switch (key) {
							case "sessions":
								dialog.open({
									children: <SessionsDialogContent />,
									padding: { bottom: 1, right: 0, top: 1, left: 0 },
									titleMargin: { left: 4, right: 4 },
									title,
								});
								break;
							case "theme":
								dialog.open({
									children: <ThemeDialogContent />,
									title,
								});
								break;
							default:
								break;
						}
					},
				}),
				models: new ModelsAdapter({
					open: ({ models, currentModel, onSelectModel }) => {
						dialog.open({
							children: (
								<ModelsDialogContent
									currentModel={currentModel}
									models={models}
									onSelectModel={onSelectModel}
								/>
							),
							title: "Select Model",
						});
					},
					currentModel: model,
					setModel,
				}),
				mode: new ModeAdapter({
					open: ({ currentMode, onSelectMode }) => {
						dialog.open({
							children: (
								<AgentsDialogContent
									currentMode={currentMode}
									onSelectMode={onSelectMode}
								/>
							),
							title: "Select Agent",
						});
					},
					currentMode: mode,
					setMode,
				}),
				unavailable: new UnavailableAdapter({
					show: (message) => {
						toast.show({ message, variant: "info" });
					},
				}),
			}),
		[dialog.open, renderer, router, mode, model, setMode, setModel, toast.show]
	);

	const executeCommand = useCallback(
		async (spec: CommandSpec) => {
			try {
				await execute(spec);
			} catch (error) {
				toast.show({
					message: error instanceof Error ? error.message : "Command failed",
					variant: "error",
				});
			}
		},
		[execute, toast.show]
	);

	return { executeCommand };
}
