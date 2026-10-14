import type { OpenAIBrowserLoginOptions } from "@wincode/ai/sdk/providers/openai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionApiKeyDialogContent } from "@/modules/connections/ui/connection-api-key-dialog";
import { createPluginTextInputRequester } from "@/modules/plugins/ui/request-plugin-text-input";
import type {
	InteractiveProviderController,
	InteractiveProviderOption,
} from "@/modules/providers/interactive-provider-controller";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

const openRouterSdkProvider = {
	displayName: "OpenRouter Provider SDK",
	methods: ["api-key"] as const,
};

type Props = Readonly<{
	controller: InteractiveProviderController;
}>;

type ProviderPickerProps = Readonly<{
	connectingProviderId: string | undefined;
	error: string | undefined;
	onSelect: (provider: InteractiveProviderOption) => void;
	providers: readonly InteractiveProviderOption[];
}>;

type OpenAIOAuthStatus = Parameters<
	NonNullable<OpenAIBrowserLoginOptions["onStatus"]>
>[0];

const OpenAIOAuthProgress = ({
	error,
	status,
}: {
	error: string | undefined;
	status: OpenAIOAuthStatus | undefined;
}) => {
	const { colors } = useTheme();
	useDialogEscape();
	let statusMessage: string;
	switch (status) {
		case "opening-browser":
			statusMessage = "Opening browser for OpenAI sign-in…";
			break;
		case "waiting-for-callback":
			statusMessage = "Waiting for the OpenAI sign-in callback…";
			break;
		case "exchanging-token":
			statusMessage = "Completing OpenAI sign-in…";
			break;
		default:
			statusMessage = "Preparing OpenAI browser sign-in…";
	}
	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.textMuted}>{statusMessage}</text>
			{error === undefined ? null : <text fg={colors.error}>{error}</text>}
		</box>
	);
};

const ProviderSdkProviderPicker = ({
	connectingProviderId,
	error,
	onSelect,
	providers,
}: ProviderPickerProps) => {
	const { colors } = useTheme();
	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.textMuted}>
				Choose a Provider. API keys are saved by the host; Plugin inputs are
				requested by the host and credentials stay in the Provider SDK store.
			</text>
			{error === undefined ? null : <text fg={colors.error}>{error}</text>}
			<SearchListDialogWrapper
				emptyText="No Provider SDK connection interactions are registered."
				getKey={({ kind, providerId }) => `${kind}:${providerId}`}
				getSearchText={({ displayName, providerId }) =>
					`${displayName} ${providerId}`
				}
				isItemSelectable={() => connectingProviderId === undefined}
				items={providers}
				onSelect={onSelect}
				placeholder="Search Providers"
				renderItem={(provider, isSelected) => (
					<SelectableDialogItem>
						<text fg={isSelected ? colors.primary : colors.text}>
							{connectingProviderId === provider.providerId
								? `Connecting ${provider.displayName}…`
								: provider.displayName}
						</text>
					</SelectableDialogItem>
				)}
			/>
		</box>
	);
};

/** Connects built-in Providers and trusted Plugins without exposing host keys to Plugins. */
export const ProviderSdkConnectDialogContent = ({ controller }: Props) => {
	const dialog = useDialog();
	const { show } = useToast();
	const [selectedProvider, setSelectedProvider] =
		useState<InteractiveProviderOption>();
	const [connectingProviderId, setConnectingProviderId] = useState<
		string | undefined
	>();
	const [error, setError] = useState<string | undefined>();
	const [oauthStatus, setOauthStatus] = useState<
		OpenAIOAuthStatus | undefined
	>();
	const connectAbortController = useRef<AbortController | undefined>(undefined);
	useEffect(
		() => () => {
			connectAbortController.current?.abort(
				new DOMException("Provider connection dialog dismissed", "AbortError")
			);
		},
		[]
	);
	const requestTextInput = useMemo(
		() => createPluginTextInputRequester(dialog),
		[dialog]
	);
	const providers = controller.getConnectableProviders();
	const connectOpenAIOAuth = useCallback(
		async (provider: InteractiveProviderOption) => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setError(undefined);
			setOauthStatus(undefined);
			setConnectingProviderId(provider.providerId);
			try {
				await controller.connectOpenAIOAuth({
					onStatus: setOauthStatus,
					signal: abortController.signal,
				});
				if (abortController.signal.aborted) {
					return;
				}
				dialog.close();
				show({
					message: "OpenAI connected with browser sign-in.",
					variant: "success",
				});
			} catch {
				if (!abortController.signal.aborted) {
					setError("OpenAI browser sign-in failed.");
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
		[controller, dialog, show]
	);
	const connectPluginProvider = useCallback(
		async (provider: InteractiveProviderOption) => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setError(undefined);
			setConnectingProviderId(provider.providerId);
			try {
				const result = await controller.connectPluginProvider(
					provider.providerId,
					requestTextInput,
					{ signal: abortController.signal }
				);
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
				dialog.close();
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
		[controller, dialog, requestTextInput, show]
	);

	if (selectedProvider?.kind === "openrouter") {
		const submit = async (
			apiKey: string,
			signal: AbortSignal
		): Promise<void> => {
			await controller.connectOpenRouterApiKey(apiKey, { signal });
			if (signal.aborted) {
				return;
			}
			dialog.close();
			show({
				message: "OpenRouter Provider connected and Known Models refreshed.",
				variant: "success",
			});
		};
		return (
			<ConnectionApiKeyDialogContent
				maskInput
				onSubmit={submit}
				placeholder="Paste OpenRouter API key"
				provider={openRouterSdkProvider}
			/>
		);
	}

	if (selectedProvider?.kind === "openai-oauth") {
		return <OpenAIOAuthProgress error={error} status={oauthStatus} />;
	}

	if (selectedProvider?.kind === "api-key") {
		const submit = async (
			apiKey: string,
			signal: AbortSignal
		): Promise<void> => {
			await controller.connectProviderApiKey(
				selectedProvider.providerId,
				apiKey,
				{ signal }
			);
			if (signal.aborted) {
				return;
			}
			dialog.close();
			show({
				message: `${selectedProvider.displayName} API key saved to the Provider SDK.`,
				variant: "success",
			});
		};
		return (
			<ConnectionApiKeyDialogContent
				maskInput
				onSubmit={submit}
				placeholder={`Paste ${selectedProvider.displayName} API key`}
				provider={{
					displayName: selectedProvider.displayName,
					methods: ["api-key"],
				}}
			/>
		);
	}

	return (
		<ProviderSdkProviderPicker
			connectingProviderId={connectingProviderId}
			error={error}
			onSelect={(provider) => {
				setSelectedProvider(provider);
				if (provider.kind === "plugin") {
					void connectPluginProvider(provider);
				}
				if (provider.kind === "openai-oauth") {
					void connectOpenAIOAuth(provider);
				}
			}}
			providers={providers}
		/>
	);
};
