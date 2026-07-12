import { useRenderer } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import open from "open";
import { createElement, useCallback, useMemo } from "react";
import {
	ConnectAdapter,
	DialogAdapter,
	ExitAdapter,
	ModeAdapter,
	ModelsAdapter,
	NewAdapter,
	UnavailableAdapter,
} from "@/modules/commands/adapters";
import type { CommandSpec } from "@/modules/commands/commands";
import { createCommandExecutor } from "@/modules/commands/execute-command";
import {
	CONNECTION_DIALOG_WIDTH,
	ConnectDialogContent,
	connectOpenAIBrowser,
	connectProvider,
	connectWincodeBrowser,
	createConnectionsStore,
	getWincodeBrowserConfig,
	migrateLegacyWincodeSession,
	readLegacyWincodeSession,
	validateWincodeApiKey,
} from "@/modules/connections";
import type { ProviderId } from "@/modules/connections/types";
import { SessionsDialogContent } from "@/modules/conversations/ui/dialogs/sessions-dialog";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { AgentsDialogContent } from "@/modules/prompt-settings/ui/agents-dialog";
import { ModelsDialogContent } from "@/modules/prompt-settings/ui/models-dialog";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";

type UseCommandExecutorReturn = {
	executeCommand: (spec: CommandSpec) => Promise<void>;
};

type BrowserConnectCallbacksWithSignal = {
	setAuthorizationUrl: (authorizationUrl: string) => void;
	setStatus: (status: string) => void;
	signal?: AbortSignal;
};

export async function copyBrowserAuthorizationUrl(
	renderer: Pick<ReturnType<typeof useRenderer>, "copyToClipboardOSC52">,
	url: string,
	spawnProcess?: (command: [string], stdin: string) => Promise<number>
): Promise<void> {
	if (renderer.copyToClipboardOSC52(url)) {
		return;
	}

	if (process.platform !== "darwin") {
		throw new Error("Clipboard is not supported by this terminal.");
	}

	const spawn =
		spawnProcess ??
		(async (command: [string], stdin: string) => {
			const bun = globalThis as typeof globalThis & {
				Bun: {
					spawn: (
						cmds: [string],
						options: { stdin: string }
					) => { exited: Promise<number> };
				};
			};
			const processHandle = bun.Bun.spawn(command, { stdin });
			return await processHandle.exited;
		});
	const exitCode = await spawn(["pbcopy"], url);
	if (exitCode !== 0) {
		throw new Error("Failed to copy URL.");
	}
}

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
				connect: new ConnectAdapter({
					open: async () => {
						const store = createConnectionsStore();
						await migrateLegacyWincodeSession(readLegacyWincodeSession, store);
						const connectedProviderIds = (
							await Promise.all(
								(["wincode", "openai", "anthropic"] as const).map(
									async (providerId) => await store.getStatus(providerId)
								)
							)
						)
							.filter((status) => status.connected)
							.map((status) => status.providerId);
						dialog.open({
							children: createElement(ConnectDialogContent, {
								connectedProviderIds,
								onApiKeySubmit: async (
									providerId: ProviderId,
									apiKey: string
								) => {
									await connectProvider(
										store,
										providerId,
										{ kind: "api-key", apiKey },
										providerId === "wincode"
											? {
													wincodeValidate: async (credential) => {
														if (!("apiKey" in credential)) {
															throw new Error(
																"Wincode API key validation failed."
															);
														}
														await validateWincodeApiKey(credential.apiKey);
													},
												}
											: undefined
									);
									toast.show({
										message: `${providerId} connected.`,
										variant: "success",
									});
								},
								onBrowserConnect: async (
									providerId: ProviderId,
									callbacks: BrowserConnectCallbacksWithSignal
								) => {
									const signal = callbacks.signal;
									if (providerId === "openai") {
										await connectOpenAIBrowser({
											backend: store,
											openBrowser: false,
											onAuthorizationUrl: (authorizationUrl) =>
												callbacks.setAuthorizationUrl(authorizationUrl.href),
											onStatus: (status) => callbacks.setStatus(status),
											signal,
										});
										toast.show({
											message: "OpenAI connected.",
											variant: "success",
										});
										return;
									}
									const config = getWincodeBrowserConfig();
									await connectWincodeBrowser({
										backend: store,
										clientId: config.clientId,
										issuer: config.issuer,
										openBrowser: false,
										resource: config.resource,
										onAuthorizationUrl: (authorizationUrl) =>
											callbacks.setAuthorizationUrl(authorizationUrl.href),
										onStatus: (status) => callbacks.setStatus(status),
										signal,
										redirectUri: config.redirectUri,
									});
									toast.show({
										message: "Wincode connected.",
										variant: "success",
									});
								},
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
							}),
							title: "Connect",
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
		[dialog, renderer, router, mode, model, setMode, setModel, toast.show]
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
