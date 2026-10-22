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

type MethodOption =
	| Readonly<{
			kind: "connect";
			details: string;
			label: string;
			option: InteractiveProviderOption;
	  }>
	| Readonly<{
			kind: "verify" | "logout";
			details: string;
			label: string;
	  }>;

type ProviderAuthStatus =
	| "checking"
	| "configured"
	| "verified"
	| "missing"
	| "invalid"
	| "error";

type ProviderPickerProps = Readonly<{
	authStatusByProviderId: ReadonlyMap<string, ProviderAuthStatus>;
	connectingProviderId: string | undefined;
	error: string | undefined;
	onSelect: (provider: ProviderGroup) => void;
	providers: readonly ProviderGroup[];
}>;

type ProviderMethodPickerProps = Readonly<{
	isConfigured: boolean;
	onSelect: (method: MethodOption) => void;
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

const getProviderAuthStatusLabel = (
	status: ProviderAuthStatus | undefined
): string => {
	switch (status) {
		case "checking":
			return "Checking credentials";
		case "configured":
			return "Credential saved · not verified";
		case "verified":
			return "Verified in this session";
		case "missing":
			return "No credential saved";
		case "invalid":
			return "Credential is invalid";
		case "error":
			return "Status unavailable";
		default:
			return "Status unavailable";
	}
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

const connectMethodCopyFor = (
	option: InteractiveProviderOption
): Readonly<{ details: string; label: string }> => {
	if (option.kind === "plugin") {
		return {
			details: "Use the Plugin Provider sign-in flow.",
			label: "Plugin sign-in",
		};
	}
	if (option.kind === "oauth") {
		return {
			details: "Open a browser and copy the URL.",
			label: "Browser sign-in",
		};
	}
	return {
		details: "Paste a key directly into the terminal.",
		label: "API key",
	};
};

const methodOptionsFor = (
	options: readonly InteractiveProviderOption[],
	isConfigured: boolean
): readonly MethodOption[] => [
	...options.map(
		(option): MethodOption => ({
			kind: "connect",
			...connectMethodCopyFor(option),
			option,
		})
	),
	...(isConfigured
		? [
				{
					kind: "verify" as const,
					details: "Ask the provider to validate saved credentials.",
					label: "Verify saved credentials",
				},
				{
					kind: "logout" as const,
					details: "Remove this Provider SDK credential.",
					label: "Log out",
				},
			]
		: []),
];

const apiKeyDialogMethodsFor = (
	options: readonly InteractiveProviderOption[]
): readonly ("api-key" | "browser")[] =>
	options.flatMap((option) => {
		if (option.kind === "plugin") {
			return [];
		}
		return [option.kind === "oauth" ? "browser" : "api-key"];
	});

const getMethodLabelColumnWidth = (options: readonly MethodOption[]): number =>
	Math.max(17, ...options.map(({ label }) => label.length + 2));

const ProviderPicker = ({
	authStatusByProviderId,
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
				`${provider.displayName} ${getProviderDetails(provider.options)} ${provider.providerId} ${authStatusByProviderId.get(provider.providerId) ?? ""}`
			}
			isItemActive={(provider) =>
				authStatusByProviderId.get(provider.providerId) === "configured" ||
				authStatusByProviderId.get(provider.providerId) === "verified"
			}
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
									? `Updating ${provider.displayName}…`
									: provider.displayName}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{`${getProviderDetails(provider.options)} · ${getProviderAuthStatusLabel(authStatusByProviderId.get(provider.providerId))}`}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
};

const ProviderMethodPicker = ({
	isConfigured,
	onSelect,
	options,
}: ProviderMethodPickerProps) => {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const methods = methodOptionsFor(options, isConfigured);
	const labelColumnWidth = getMethodLabelColumnWidth(methods);
	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No available methods"
			getKey={(method) =>
				method.kind === "connect" ? method.option.methodId : method.kind
			}
			getSearchText={(method) => `${method.label} ${method.details}`}
			items={methods}
			onSelect={onSelect}
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
						`${providerName} browser sign-in completed and credentials were saved.`,
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
	const [authStatusByProviderId, setAuthStatusByProviderId] = useState<
		ReadonlyMap<string, ProviderAuthStatus>
	>(new Map());
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
		const checkProviderAuth = controller.checkProviderAuth;
		if (checkProviderAuth === undefined) {
			setAuthStatusByProviderId(new Map());
			return () => {
				active = false;
			};
		}
		const abortController = new AbortController();
		setAuthStatusByProviderId(
			new Map(providers.map(({ providerId }) => [providerId, "checking"]))
		);
		void Promise.all(
			providers.map(async ({ providerId }) => {
				try {
					const result = await checkProviderAuth(providerId, {
						signal: abortController.signal,
					});
					let status: ProviderAuthStatus;
					switch (result.status) {
						case "configured":
							status = "configured";
							break;
						case "invalid":
							status = "invalid";
							break;
						case "error":
							status = "error";
							break;
						default:
							status = "missing";
					}
					return [providerId, status] as const;
				} catch {
					return [providerId, "error"] as const;
				}
			})
		).then((statuses) => {
			if (active) {
				setAuthStatusByProviderId(new Map(statuses));
			}
		});
		return () => {
			active = false;
			abortController.abort(
				new DOMException("Provider status check cancelled", "AbortError")
			);
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
					message: `${provider.displayName} sign-in completed and Known Models refreshed.`,
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

	const verifyProviderAuth = useCallback(
		async (provider: ProviderGroup, signal: AbortSignal): Promise<void> => {
			const result = await controller.verifyProviderAuth(provider.providerId, {
				signal,
			});
			if (result.status === "aborted" || signal.aborted) {
				return;
			}
			switch (result.status) {
				case "error":
					show({ message: result.failure.message, variant: "error" });
					return;
				case "verified":
					setAuthStatusByProviderId((current) =>
						new Map(current).set(provider.providerId, "verified")
					);
					show({
						message: `${provider.displayName} credentials were verified by the provider.`,
						variant: "success",
					});
					return;
				case "unsupported":
					show({
						message: `${provider.displayName} does not support explicit credential verification.`,
						variant: "info",
					});
					return;
				case "missing":
					setAuthStatusByProviderId((current) =>
						new Map(current).set(provider.providerId, "missing")
					);
					show({
						message: `${provider.displayName} has no saved credentials.`,
						variant: "error",
					});
					return;
				case "invalid":
					setAuthStatusByProviderId((current) =>
						new Map(current).set(provider.providerId, "invalid")
					);
					show({
						message: `${provider.displayName} credentials are invalid.`,
						variant: "error",
					});
					return;
				default:
					return;
			}
		},
		[controller, show]
	);

	const logoutProviderAuth = useCallback(
		async (provider: ProviderGroup, signal: AbortSignal): Promise<void> => {
			const result = await controller.logoutProvider(provider.providerId, {
				signal,
			});
			if (result.status === "aborted" || signal.aborted) {
				return;
			}
			if (result.status === "error") {
				show({ message: result.failure.message, variant: "error" });
				return;
			}
			setAuthStatusByProviderId((current) =>
				new Map(current).set(provider.providerId, "missing")
			);
			show({
				message: `${provider.displayName} Provider SDK credentials were removed.`,
				variant: "success",
			});
		},
		[controller, show]
	);

	const runProviderAuthAction = useCallback(
		async (provider: ProviderGroup, action: "verify" | "logout") => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setConnectingProviderId(provider.providerId);
			try {
				if (action === "verify") {
					await verifyProviderAuth(provider, abortController.signal);
				} else {
					await logoutProviderAuth(provider, abortController.signal);
				}
			} catch (actionError) {
				if (!abortController.signal.aborted) {
					show({
						message: getErrorMessage(
							actionError,
							"Provider auth action failed."
						),
						variant: "error",
					});
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
		[logoutProviderAuth, show, verifyProviderAuth]
	);

	const openProviderMethods = useCallback(
		(provider: ProviderGroup) => {
			setError(undefined);
			const isConfigured =
				authStatusByProviderId.get(provider.providerId) === "configured" ||
				authStatusByProviderId.get(provider.providerId) === "verified";
			const pluginOption = provider.options.find(
				(option): option is PluginConnectOption => option.kind === "plugin"
			);
			if (pluginOption !== undefined && !isConfigured) {
				void connectPluginProvider(provider, pluginOption);
				return;
			}
			dialog.open({
				children: (
					<ProviderMethodPicker
						isConfigured={isConfigured}
						onSelect={(method) => {
							if (method.kind !== "connect") {
								void runProviderAuthAction(provider, method.kind);
								return;
							}
							const option = method.option;
							if (option.kind === "plugin") {
								dialog.close();
								void connectPluginProvider(provider, option);
								return;
							}
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
															`${provider.displayName} API key saved and Known Models refreshed.`)
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
				title: "Choose action",
				width: PROVIDER_DIALOG_WIDTH,
			});
		},
		[
			authStatusByProviderId,
			connectPluginProvider,
			dialog,
			onBrowserCopyUrl,
			onBrowserOpenUrl,
			runProviderAuthAction,
			show,
		]
	);

	return (
		<ProviderPicker
			authStatusByProviderId={authStatusByProviderId}
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
