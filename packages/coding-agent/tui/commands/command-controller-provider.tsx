import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { getErrorMessage } from "@wincode/utils";
import {
	createElement,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useRefreshAgentRegistry } from "@/modules/agents";
import {
	type CommandControllerFactory,
	createCommandController,
} from "@/modules/commands/command-controller";
import { CommandControllerFactoryProvider } from "@/modules/commands/command-controller-context";
import type { CommandSpec } from "@/modules/commands/commands";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import { createCommandExecutor } from "@/modules/commands/execute-command";
import { useConnections } from "@/modules/connections";
import { PluginStatusPanelDialogContent } from "@/modules/plugins/ui/plugin-status-panel-dialog";
import {
	getProjectTrustStatus,
	saveProjectTrustDecision,
} from "@/modules/project-trust/project-trust";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { discoverSkills, type Skill } from "@/modules/skills";
import { useConfig } from "@/shared/config/config-provider";
import { resolveUserWincodeDir } from "@/shared/paths/user-data-dir";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
import { createCommandHandlers } from "./command-strategies";
import { openCommandDialog } from "./dialog-command";
import { requestProjectTrust } from "./project-trust-dialog";
import { reloadInteractiveResources } from "./reload-resources";

export function CommandControllerProvider({
	children,
}: {
	children: ReactNode;
}) {
	const config = useConfig();
	const pluginRuntime = getInteractivePluginRuntime();
	const renderer = useRenderer();
	const router = useRouter();
	const dialog = useDialog();
	const toast = useToast();
	const { reloadTheme } = useTheme();
	const connections = useConnections();
	const refreshAgentRegistry = useRefreshAgentRegistry();
	const promptConfig = usePromptConfig();
	const [customCommands, setCustomCommands] = useState<CustomCommandSpec[]>([]);
	const [skills, setSkills] = useState<Skill[]>([]);
	const discoverCustomCommands = useCallback(
		() => getCustomCommands(config),
		[config]
	);
	const discoverAvailableSkills = useCallback(
		() => discoverSkills(config),
		[config]
	);
	const reloadResources = useCallback(
		() =>
			reloadInteractiveResources({
				refreshAgentRegistry,
				reloadTheme,
				toast,
			}),
		[refreshAgentRegistry, reloadTheme, toast]
	);
	const trustProject = useCallback(async () => {
		const projectTrustDir = resolveUserWincodeDir(config.homeRoot);
		const status = await getProjectTrustStatus({
			projectTrustDir,
			trustedProjectRoots: config.trustedProjectRoots ?? [],
			workspace: config.workspace,
		});
		const choice = await requestProjectTrust(dialog, {
			projectRoot: config.workspace,
			...status,
		});
		const decision = choice === "deny" ? "deny" : "trust";
		let message: string;
		if (choice === "trust-parent") {
			message =
				"Parent folder trust saved. Run /reload to load project resources.";
		} else if (decision === "trust") {
			message = "Project trust saved. Run /reload to load project resources.";
		} else {
			message = "Project marked untrusted. Run /reload to apply the decision.";
		}
		await saveProjectTrustDecision({
			decision,
			projectTrustDir,
			scope: choice === "trust-parent" ? "parent" : "project",
			workspace: config.workspace,
		});
		toast.show({
			message,
			variant: decision === "trust" ? "success" : "info",
		});
	}, [
		config.homeRoot,
		config.trustedProjectRoots,
		config.workspace,
		dialog,
		toast,
	]);

	useEffect(() => {
		let active = true;
		void discoverCustomCommands()
			.then((commands) => {
				if (active) {
					setCustomCommands(commands);
				}
			})
			.catch(() => {
				if (active) {
					setCustomCommands([]);
				}
			});
		void discoverAvailableSkills()
			.then((availableSkills) => {
				if (active) {
					setSkills(availableSkills);
				}
			})
			.catch(() => {
				if (active) {
					setSkills([]);
				}
			});
		return () => {
			active = false;
		};
	}, [discoverAvailableSkills, discoverCustomCommands]);

	const create = useCallback<CommandControllerFactory["create"]>(
		(options) => {
			const execute = createCommandExecutor(
				createCommandHandlers({
					config: promptConfig,
					connections,
					dialog,
					getRecentModelSelections: (limit) =>
						getSessionStore().listRecentModelSelections(limit),
					navigateHome: () => {
						router.navigate({ to: "/" }).catch(() => undefined);
					},
					onCompact: options.onCompact,
					onReload: reloadResources,
					onTrust: trustProject,
					onOpenSettings: options.onOpenSettings,
					refreshAgentRegistry,
					renderer,
					toast,
				})
			);
			const executeCommand = async (spec: CommandSpec): Promise<void> => {
				try {
					await execute(spec);
				} catch (error) {
					toast.show({
						message: getErrorMessage(error, "Command failed"),
						variant: "error",
					});
				}
			};

			return createCommandController({
				...options,
				customCommands,
				pluginCommands: pluginRuntime?.getCommands(options.sessionId) ?? [],
				executePluginCommand: async (command, argument, sessionId) => {
					if (pluginRuntime === undefined) {
						options.onError(
							`Plugin command "/${command.name}" is unavailable.`
						);
						return;
					}
					try {
						if (command.statusPanelId !== undefined) {
							const panel = pluginRuntime
								.getStatusPanels()
								.find(
									(candidate) =>
										candidate.pluginId === command.pluginId &&
										candidate.id === command.statusPanelId
								);
							if (panel === undefined) {
								throw new Error("Plugin Status Panel is unavailable.");
							}
							openCommandDialog(dialog, {
								children: createElement(PluginStatusPanelDialogContent, {
									panel,
									pluginRuntime,
								}),
								title: panel.title,
							});
							return;
						}
						const message = await pluginRuntime.executeCommand(
							command.pluginId,
							command.name,
							{
								argument,
								...(sessionId === undefined ? {} : { sessionId }),
								workspace: config.workspace,
							}
						);
						toast.show({
							message: message || "Plugin command completed.",
							variant: "info",
						});
					} catch (error) {
						options.onError(getErrorMessage(error, "Plugin command failed."));
					}
				},
				discoverCustomCommands,
				discoverSkills: discoverAvailableSkills,
				executeCommand,
				skills,
			});
		},
		[
			connections,
			config.workspace,
			customCommands,
			dialog,
			discoverAvailableSkills,
			discoverCustomCommands,
			promptConfig,
			reloadResources,
			trustProject,
			refreshAgentRegistry,
			renderer,
			router,
			skills,
			toast,
			pluginRuntime,
		]
	);
	const factory = useMemo<CommandControllerFactory>(
		() => ({ create }),
		[create]
	);

	return (
		<CommandControllerFactoryProvider factory={factory}>
			{children}
		</CommandControllerFactoryProvider>
	);
}
