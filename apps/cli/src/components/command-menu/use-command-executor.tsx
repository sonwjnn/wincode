import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useDialog } from "../../providers/dialog";
import { usePromptConfig } from "../../providers/prompt-config";
import { useToast } from "../../providers/toast";
import {
	AgentsDialogContent,
	ModelsDialogContent,
	SessionsDialogContent,
	ThemeDialogContent,
} from "../dialogs";
import {
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from "./adapters";
import type { CommandSpec } from "./commands";
import { createCommandExecutor } from "./execute-command";

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
