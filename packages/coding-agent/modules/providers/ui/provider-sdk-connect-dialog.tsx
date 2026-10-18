import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPluginTextInputRequester } from "@/modules/plugins/ui/request-plugin-text-input";
import { BUILT_IN_PROVIDER_CATALOG } from "@/modules/providers/built-in-provider-catalog";
import type {
	InteractiveProviderController,
	InteractiveProviderOption,
} from "@/modules/providers/interactive-provider-controller";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { DialogInset } from "@/shared/ui/dialog-inset";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import { ProviderApiKeyDialogContent } from "./provider-api-key-dialog";

type Props = Readonly<{
	controller: InteractiveProviderController;
	onBrowserCopyUrl?: (url: string) => void | Promise<void>;
	onBrowserOpenUrl?: (url: string) => void | Promise<void>;
}>;

type ProviderGroup = Readonly<{
	displayName: string;
	options: readonly InteractiveProviderOption[];
	providerId: string;
}>;

type MethodOption = Readonly<{
	details: string;
	label: string;
	option: InteractiveProviderOption;
}>;

type ProviderPickerProps = Readonly<{
	connectedProviderIds: ReadonlySet<string>;
	connectingProviderId: string | undefined;
	error: string | undefined;
	onSelect: (provider: ProviderGroup) => void;
	providers: readonly ProviderGroup[];
}>;

type ProviderMethodPickerProps = Readonly<{
	onSelect: (option: InteractiveProviderOption) => void;
	options: readonly InteractiveProviderOption[];
}>;

const PROVIDER_DIALOG_WIDTH = 60;
const PROVIDER_DISPLAY_NAME_SUFFIX = /(?: Provider SDK| browser sign-in)$/u;

const getProviderDisplayName = (option: InteractiveProviderOption): string => {
	if (option.kind === "plugin") {
		return option.displayName;
	}
	return option.displayName.replace(PROVIDER_DISPLAY_NAME_SUFFIX, "");
};

const getProviderDetails = (options: readonly InteractiveProviderOption[]) => {
	const hasBrowserSignIn = options.some((option) => option.kind === "oauth");
	const hasApiKey = options.some(
		(option) =>
			option.kind === "api-key" ||
			option.kind === "api-key-with-model-discovery"
	);
	if (hasBrowserSignIn && hasApiKey) {
		return "Browser sign-in or API key";
	}
	if (hasBrowserSignIn) {
		return "Browser sign-in";
	}
	if (options.some((option) => option.kind === "plugin")) {
		return "Plugin sign-in";
	}
	return "API key only";
};

const groupProviders = (
	options: readonly InteractiveProviderOption[]
): readonly ProviderGroup[] => {
	const providerOptionsById = new Map<string, InteractiveProviderOption[]>();
	for (const option of options) {
		const group = providerOptionsById.get(option.providerId);
		if (group === undefined) {
			providerOptionsById.set(option.providerId, [option]);
		} else {
			group.push(option);
		}
	}
	const builtInOrder = Object.keys(BUILT_IN_PROVIDER_CATALOG);
	const groups: ProviderGroup[] = [];
	for (const [providerId, providerOptions] of providerOptionsById) {
		const firstOption = providerOptions[0];
		if (firstOption === undefined) {
			continue;
		}
		groups.push({
			displayName: getProviderDisplayName(firstOption),
			options: providerOptions,
			providerId,
		});
	}
	return groups.sort((left, right) => {
		const leftIndex = builtInOrder.indexOf(left.providerId);
		const rightIndex = builtInOrder.indexOf(right.providerId);
		if (leftIndex !== -1 || rightIndex !== -1) {
			if (leftIndex === -1) {
				return 1;
			}
			if (rightIndex === -1) {
				return -1;
			}
			return leftIndex - rightIndex;
		}
		return left.displayName.localeCompare(right.displayName);
	});
};

const methodOptionsFor = (
	options: readonly InteractiveProviderOption[]
): readonly MethodOption[] =>
	options.flatMap((option) => {
		if (option.kind === "plugin") {
			return [];
		}
		return [
			{
				details:
					option.kind === "oauth"
						? "Open a browser and copy the URL."
						: "Paste a key directly into the terminal.",
				label: option.kind === "oauth" ? "Browser sign-in" : "API key",
				option,
			},
		];
	});

const apiKeyDialogMethodsFor = (
	options: readonly InteractiveProviderOption[]
): readonly ("api-key" | "browser")[] =>
	methodOptionsFor(options).map(({ option }) => {
		if (option.kind === "oauth") {
			return "browser";
		}
		return "api-key";
	});

const getMethodLabelColumnWidth = (options: readonly MethodOption[]): number =>
	Math.max(17, ...options.map(({ label }) => label.length + 2));

const ProviderPicker = ({
	connectedProviderIds,
	connectingProviderId,
	error,
	onSelect,
	providers,
}: ProviderPickerProps) => {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const labelColumnWidth = Math.max(
		17,
		...providers.map(({ displayName }) => displayName.length + 2)
	);
	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No matching providers"
			error={error}
			getKey={(provider) => provider.providerId}
			getSearchText={(provider) =>
				`${provider.displayName} ${getProviderDetails(provider.options)} ${provider.providerId}`
			}
			isItemActive={(provider) => connectedProviderIds.has(provider.providerId)}
			isItemSelectable={() => connectingProviderId === undefined}
			items={providers}
			onSelect={onSelect}
			placeholder="Search providers"
			renderItem={(provider, isSelected, isActive) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text
								fg={isSelected ? selectedTextColor : colors.success}
								selectable={false}
							>
								{"✓"}
							</text>
						) : null
					}
				>
					<box flexDirection="row" gap={1}>
						<box flexShrink={0} width={labelColumnWidth}>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{connectingProviderId === provider.providerId
									? `Connecting ${provider.displayName}…`
									: provider.displayName}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								attributes={isSelected ? undefined : TextAttributes.DIM}
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{getProviderDetails(provider.options)}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
};

const ProviderMethodPicker = ({
	onSelect,
	options,
}: ProviderMethodPickerProps) => {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const methods = methodOptionsFor(options);
	const labelColumnWidth = getMethodLabelColumnWidth(methods);
	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No available methods"
			getKey={(method) => method.option.methodId}
			getSearchText={(method) => `${method.label} ${method.details}`}
			items={methods}
			onSelect={(method) => onSelect(method.option)}
			placeholder="Search methods"
			renderItem={(method, isSelected) => (
				<SelectableDialogItem>
					<box flexDirection="row" flexGrow={1} gap={1}>
						<box flexShrink={0} width={labelColumnWidth}>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{method.label}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								attributes={isSelected ? undefined : TextAttributes.DIM}
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{method.details}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
};

const ProviderOAuthProgress = ({
	onBrowserCopyUrl,
	onBrowserOpenUrl,
	option,
	providerName,
}: {
	onBrowserCopyUrl: Props["onBrowserCopyUrl"];
	onBrowserOpenUrl: Props["onBrowserOpenUrl"];
	option: Extract<InteractiveProviderOption, { kind: "oauth" }>;
	providerName: string;
}) => {
	const { closeAll } = useDialog();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();
	const { show } = useToast();
	const [authorizationUrl, setAuthorizationUrl] = useState<string>();
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState<string>("Waiting for browser sign-in.");
	useEffect(() => {
		const abortController = new AbortController();
		void option
			.connectOAuth({
				onAuthorizationUrl: (url) => {
					if (!abortController.signal.aborted) {
						setAuthorizationUrl(url.href);
					}
				},
				onStatus: setStatus,
				openBrowser: false,
				signal: abortController.signal,
			})
			.then(() => {
				if (abortController.signal.aborted) {
					return;
				}
				closeAll();
				show({
					message:
						option.successMessage ??
						`${providerName} connected with browser sign-in.`,
					variant: "success",
				});
			})
			.catch((connectError: unknown) => {
				if (!abortController.signal.aborted) {
					setError(getErrorMessage(connectError, "Browser sign-in failed."));
					setStatus("Browser sign-in failed.");
				}
			});
		return () => {
			abortController.abort(
				new DOMException("Provider connection dialog dismissed", "AbortError")
			);
		};
	}, [closeAll, option, providerName, show]);

	const handleCopy = useCallback(async () => {
		if (authorizationUrl === undefined) {
			return;
		}
		try {
			await onBrowserCopyUrl?.(authorizationUrl);
		} catch (copyError) {
			setError(getErrorMessage(copyError, "Could not copy authorization URL."));
		}
	}, [authorizationUrl, onBrowserCopyUrl]);
	const handleOpen = useCallback(async () => {
		if (authorizationUrl === undefined || onBrowserOpenUrl === undefined) {
			return;
		}
		setError(undefined);
		try {
			await onBrowserOpenUrl(authorizationUrl);
		} catch (openError) {
			setError(getErrorMessage(openError, "Could not open the browser."));
		}
	}, [authorizationUrl, onBrowserOpenUrl]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId) || key.name !== "c" || !authorizationUrl) {
			return;
		}
		key.preventDefault();
		void handleCopy();
	});
	useDialogEscape();

	let statusMessage = status;
	if (status === "opening-browser") {
		statusMessage = `Opening browser for ${providerName} sign-in…`;
	} else if (status === "waiting-for-callback") {
		statusMessage = `Waiting for the ${providerName} sign-in callback…`;
	} else if (status === "exchanging-token") {
		statusMessage = `Completing ${providerName} sign-in…`;
	}

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<text fg={colors.text} selectable={false}>
					{statusMessage}
				</text>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
				<text
					fg={colors.info}
					onMouseDown={() => {
						void handleOpen();
					}}
					selectable
					width="100%"
					wrapMode="char"
				>
					{authorizationUrl ?? "Waiting for browser sign-in..."}
				</text>
				{error ? <text fg={colors.error}>{error}</text> : null}
				<box flexDirection="row" gap={2} height={1}>
					<DialogFooterHint label="copy" shortcut="c" />
				</box>
			</box>
		</DialogInset>
	);
};

/** Connects built-in Providers and trusted Plugins without exposing host keys to Plugins. */
export const ProviderSdkConnectDialogContent = ({
	controller,
	onBrowserCopyUrl,
	onBrowserOpenUrl,
}: Props) => {
	const dialog = useDialog();
	const { show } = useToast();
	const [connectingProviderId, setConnectingProviderId] = useState<string>();
	const [connectedProviderIds, setConnectedProviderIds] = useState<
		ReadonlySet<string>
	>(new Set());
	const [error, setError] = useState<string>();
	const connectAbortController = useRef<AbortController | undefined>(undefined);
	const requestTextInput = useMemo(
		() => createPluginTextInputRequester(dialog),
		[dialog]
	);
	const options = useMemo(
		() => controller.getConnectableProviders(),
		[controller]
	);
	const providers = useMemo(() => groupProviders(options), [options]);

	useEffect(() => {
		let active = true;
		const getAvailableModels = controller.getAvailableModels;
		if (getAvailableModels === undefined) {
			return () => {
				active = false;
			};
		}
		void Promise.all(
			providers.map(async ({ providerId }) => {
				try {
					const models = await getAvailableModels(providerId);
					return models.length > 0 ? providerId : undefined;
				} catch {
					return;
				}
			})
		).then((availableProviderIds) => {
			if (active) {
				setConnectedProviderIds(
					new Set(
						availableProviderIds.filter(
							(providerId): providerId is string => providerId !== undefined
						)
					)
				);
			}
		});
		return () => {
			active = false;
		};
	}, [controller, providers]);

	useEffect(
		() => () => {
			connectAbortController.current?.abort(
				new DOMException("Provider connection dialog dismissed", "AbortError")
			);
		},
		[]
	);

	const connectPluginProvider = useCallback(
		async (provider: ProviderGroup, option: PluginConnectOption) => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setError(undefined);
			setConnectingProviderId(provider.providerId);
			try {
				const result = await option.connectPlugin(requestTextInput, {
					signal: abortController.signal,
				});
				if (result === undefined) {
					return;
				}
				if (
					result.kind === "saved-before-cancelled" ||
					abortController.signal.aborted
				) {
					show({
						message: `${provider.displayName} credentials were saved before the connection dialog was cancelled.`,
						variant: "success",
					});
					return;
				}
				dialog.closeAll();
				show({
					message: `${provider.displayName} connected and Known Models refreshed.`,
					variant: "success",
				});
			} catch (connectError) {
				if (!abortController.signal.aborted) {
					setError(
						connectError instanceof Error
							? connectError.message
							: "Plugin Provider connection failed."
					);
				}
			} finally {
				if (connectAbortController.current === abortController) {
					connectAbortController.current = undefined;
					if (!abortController.signal.aborted) {
						setConnectingProviderId(undefined);
					}
				}
			}
		},
		[dialog, requestTextInput, show]
	);

	const openProviderMethods = useCallback(
		(provider: ProviderGroup) => {
			setError(undefined);
			const pluginOption = provider.options.find(
				(option): option is PluginConnectOption => option.kind === "plugin"
			);
			if (pluginOption !== undefined) {
				void connectPluginProvider(provider, pluginOption);
				return;
			}
			dialog.open({
				children: (
					<ProviderMethodPicker
						onSelect={(option) => {
							if (option.kind === "oauth") {
								dialog.open({
									children: (
										<ProviderOAuthProgress
											onBrowserCopyUrl={onBrowserCopyUrl}
											onBrowserOpenUrl={onBrowserOpenUrl}
											option={option}
											providerName={provider.displayName}
										/>
									),
									title: `${provider.displayName} browser`,
									width: PROVIDER_DIALOG_WIDTH,
								});
								return;
							}
							if (
								option.kind !== "api-key" &&
								option.kind !== "api-key-with-model-discovery"
							) {
								return;
							}
							dialog.open({
								children: (
									<ProviderApiKeyDialogContent
										maskInput
										onSubmit={async (apiKey, signal) => {
											await option.connectApiKey(apiKey, { signal });
											if (signal.aborted) {
												return;
											}
											dialog.closeAll();
											show({
												message:
													option.kind === "api-key-with-model-discovery"
														? (option.successMessage ??
															`${provider.displayName} connected and Known Models refreshed.`)
														: `${provider.displayName} API key saved to the Provider SDK.`,
												variant: "success",
											});
										}}
										provider={{
											displayName: provider.displayName,
											methods: apiKeyDialogMethodsFor(provider.options),
										}}
									/>
								),
								title: `${provider.displayName} API key`,
								width: PROVIDER_DIALOG_WIDTH,
							});
						}}
						options={provider.options}
					/>
				),
				title: "Choose method",
				width: PROVIDER_DIALOG_WIDTH,
			});
		},
		[connectPluginProvider, dialog, onBrowserCopyUrl, onBrowserOpenUrl, show]
	);

	return (
		<ProviderPicker
			connectedProviderIds={connectedProviderIds}
			connectingProviderId={connectingProviderId}
			error={error}
			onSelect={openProviderMethods}
			providers={providers}
		/>
	);
};

type PluginConnectOption = Extract<
	InteractiveProviderOption,
	{ kind: "plugin" }
>;
