import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { findSupportedChatModelSelection } from "@wincode/ai";
import open from "open";
import { createElement, useCallback, useMemo } from "react";
import {
	AgentsAdapter,
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModelsAdapter,
	NewAdapter,
	SkillsAdapter,
	VariantsAdapter,
} from "@/modules/commands/adapters";
import type { CommandSpec } from "@/modules/commands/commands";
import { createCommandExecutor } from "@/modules/commands/execute-command";
import {
	CONNECTION_DIALOG_WIDTH,
	ConnectDialogContent,
	useConnections,
} from "@/modules/connections";
import { SessionsDialogContent } from "@/modules/conversations/ui/dialogs/sessions-dialog";
import { McpStatusDialogContent, useMcp } from "@/modules/mcp";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import { VariantsDialogContent } from "@/modules/prompt-settings/ui/variants-dialog";
import {
	SKILLS_DIALOG_WIDTH,
	SkillsDialogContent,
} from "@/modules/skills/ui/skills-dialog";
import {
	type ClipboardSpawn,
	writeClipboard,
} from "@/shared/clipboard/clipboard";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";

type UseCommandExecutorReturn = {
	executeCommand: (spec: CommandSpec) => Promise<void>;
};
export async function copyBrowserAuthorizationUrl(
	renderer: Pick<ReturnType<typeof useRenderer>, "copyToClipboardOSC52">,
	url: string,
	spawnProcess?: ClipboardSpawn
): Promise<void> {
	if (await writeClipboard(renderer, url, spawnProcess)) {
		return;
	}
	if (process.platform !== "darwin") {
		throw new Error("Clipboard is not supported by this terminal.");
	}
	throw new Error("Failed to copy URL.");
}

export function useCommandExecutor(
	onSelectSkill: (command: string) => void
): UseCommandExecutorReturn {
	const renderer = useRenderer();
	const router = useRouter();
	const dialog = useDialog();
	const toast = useToast();
	const connections = useConnections();
	const mcp = useMcp();
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const supportedModel = findSupportedChatModelSelection(model);
	if (!supportedModel) {
		throw new Error("Unsupported model selection.");
	}

	const execute = useMemo(
		() =>
			createCommandExecutor({
				exit: new ExitAdapter({
					destroy: () => {
						// Close the MCP registry (abort in-flight connects and close
						// clients) before tearing down the renderer.
						void mcp.close();
						renderer.destroy();
					},
				}),
				connect: new ConnectAdapter({
					open: async () => {
						const connectedProviders = await connections.listProviders();
						dialog.open({
							children: createElement(ConnectDialogContent, {
								connectedProviders,
								onBrowserCopyUrl: async (url: string) => {
									await copyBrowserAuthorizationUrl(renderer, url);
									toast.show({
										message: "Authorization URL copied.",
										variant: "success",
									});
								},
								onBrowserOpenUrl: async (url: string) => {
									await open(url);
								},
								onConnected: (summary) => {
									toast.show({
										message: `${summary.displayName} connected.`,
										variant: "success",
									});
								},
							}),
							padding: { bottom: 1, left: 0, right: 0, top: 1 },
							title: "Connect",
							titleMargin: { left: 4, right: 4 },
							width: CONNECTION_DIALOG_WIDTH,
						});
					},
				}),
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
									padding: { bottom: 1, left: 0, right: 0, top: 1 },
									title,
									titleMargin: { left: 4, right: 4 },
									width: CONNECTION_DIALOG_WIDTH,
								});
								break;
							case "mcp":
								dialog.open({
									children: <McpStatusDialogContent />,
									padding: { bottom: 1, left: 0, right: 0, top: 1 },
									title,
									titleMargin: { left: 4, right: 4 },
									width: CONNECTION_DIALOG_WIDTH,
								});
								break;
							default:
								break;
						}
					},
				}),
				models: new ModelsAdapter({
					open: ({ models, currentModel, recentSelections, onSelectModel }) =>
						dialog.open({
							children: (
								<ModelsDialogContent
									currentModel={currentModel}
									models={models}
									onSelectModel={onSelectModel}
									recentSelections={recentSelections}
								/>
							),
							padding: { bottom: 1, left: 0, right: 0, top: 1 },
							title: "Select Model",
							titleMargin: { left: 4, right: 4 },
							width: CONNECTION_DIALOG_WIDTH,
						}),
					currentModel: model,
					setModel,
				}),
				skills: new SkillsAdapter({
					open: () =>
						dialog.open({
							children: <SkillsDialogContent onSelectSkill={onSelectSkill} />,
							padding: { bottom: 1, left: 0, right: 0, top: 1 },
							title: "Skills",
							titleMargin: { left: 4, right: 4 },
							width: SKILLS_DIALOG_WIDTH,
						}),
				}),
				variants: new VariantsAdapter({
					open: ({ currentModel, currentVariant, onSelectVariant }) =>
						dialog.open({
							children: (
								<VariantsDialogContent
									currentModel={currentModel}
									currentVariant={currentVariant}
									onSelectVariant={onSelectVariant}
								/>
							),
							padding: { bottom: 1, left: 0, right: 0, top: 1 },
							title: "Select Variant",
							titleMargin: { left: 4, right: 4 },
							width: CONNECTION_DIALOG_WIDTH,
						}),
					currentModel: supportedModel,
					currentVariant: variant,
					setVariant,
				}),
				agents: new AgentsAdapter({
					open: ({ currentAgent, onSelectAgent }) =>
						dialog.open({
							children: (
								<AgentsDialogContent
									currentAgent={currentAgent}
									onSelectAgent={onSelectAgent}
								/>
							),
							padding: { bottom: 1, left: 0, right: 0, top: 1 },
							title: "Select Agent",
							titleMargin: { left: 4, right: 4 },
							width: CONNECTION_DIALOG_WIDTH,
						}),
					currentAgent: agent,
					setAgent,
				}),
			}),
		[
			agent,
			connections,
			dialog,
			mcp,
			model,
			onSelectSkill,
			renderer,
			router,
			setAgent,
			setModel,
			setVariant,
			supportedModel,
			toast.show,
			variant,
		]
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
