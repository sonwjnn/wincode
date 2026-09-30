import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { getErrorMessage } from "@wincode/runtime-utils";
import { useCallback, useMemo } from "react";
import { useRefreshAgentRegistry } from "@/modules/agents";
import type { CommandSpec } from "@/modules/commands/commands";
import {
	type CommandHandlerMap,
	createCommandExecutor,
} from "@/modules/commands/execute-command";
import { useConnections } from "@/modules/connections";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { createAppHandlers } from "./handlers/app-handlers";
import { createSelectionHandlers } from "./handlers/selection-handlers";
import { createSessionHandlers } from "./handlers/session-handlers";

type UseCommandExecutorReturn = {
	executeCommand: (spec: CommandSpec) => Promise<void>;
};

type CommandExecutorOptions = {
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onOpenSettings?: (section?: string) => Promise<void> | void;
};

export function useCommandExecutor(
	options: CommandExecutorOptions
): UseCommandExecutorReturn {
	const renderer = useRenderer();
	const router = useRouter();
	const dialog = useDialog();
	const toast = useToast();
	const connections = useConnections();
	const refreshAgentRegistry = useRefreshAgentRegistry();
	const config = usePromptConfig();

	const execute = useMemo(
		() =>
			createCommandExecutor({
				...createAppHandlers({
					connections,
					dialog,
					onOpenSettings: options.onOpenSettings,
					refreshAgentRegistry,
					renderer,
					toast,
				}),
				...createSessionHandlers({
					dialog,
					navigateHome: () => {
						router.navigate({ to: "/" }).catch(() => undefined);
					},
					onCompact: options.onCompact,
				}),
				...createSelectionHandlers({
					config,
					connections,
					dialog,
					getRecentModelSelections: (limit) =>
						getSessionStore().listRecentModelSelections(limit),
				}),
			} satisfies CommandHandlerMap),
		[
			config,
			connections,
			dialog,
			options.onCompact,
			options.onOpenSettings,
			refreshAgentRegistry,
			renderer,
			router,
			toast,
		]
	);

	const executeCommand = useCallback(
		async (spec: CommandSpec) => {
			try {
				await execute(spec);
			} catch (error) {
				toast.show({
					message: getErrorMessage(error, "Command failed"),
					variant: "error",
				});
			}
		},
		[execute, toast.show]
	);
	return { executeCommand };
}
