import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ProviderApiKeyDialogContent } from "./provider-api-key-dialog";

type Props = Readonly<{
	controller: InteractiveProviderController;
}>;

type OAuthConnectOption = Extract<InteractiveProviderOption, { kind: "oauth" }>;

type PluginConnectOption = Extract<
	InteractiveProviderOption,
	{ kind: "plugin" }
>;

type ProviderPickerProps = Readonly<{
	connectingProviderId: string | undefined;
	error: string | undefined;
	onSelect: (provider: InteractiveProviderOption) => void;
	providers: readonly InteractiveProviderOption[];
}>;

const ProviderOAuthProgress = ({
	displayName,
	error,
	status,
}: {
	displayName: string;
	error: string | undefined;
	status: string | undefined;
}) => {
	const { colors } = useTheme();
	useDialogEscape();
	let statusMessage: string;
	switch (status) {
		case "opening-browser":
			statusMessage = "Opening browser for sign-in…";
			break;
		case "waiting-for-callback":
			statusMessage = "Waiting for the sign-in callback…";
			break;
		case "exchanging-token":
			statusMessage = "Completing sign-in…";
			break;
		default:
			statusMessage = status ?? `Preparing ${displayName}…`;
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
				getKey={({ methodId, providerId }) => `${methodId}:${providerId}`}
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
	const [oauthStatus, setOauthStatus] = useState<string | undefined>();
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
	const connectOAuthProvider = useCallback(
		async (provider: OAuthConnectOption) => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setError(undefined);
			setOauthStatus(undefined);
			setConnectingProviderId(provider.providerId);
			try {
				await provider.connectOAuth({
					onStatus: setOauthStatus,
					signal: abortController.signal,
				});
				if (abortController.signal.aborted) {
					return;
				}
				dialog.close();
				show({
					message:
						provider.successMessage ?? `${provider.displayName} connected.`,
					variant: "success",
				});
			} catch (connectError) {
				if (!abortController.signal.aborted) {
					setError(
						connectError instanceof Error
							? connectError.message
							: `${provider.displayName} sign-in failed.`
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
		[dialog, show]
	);
	const connectPluginProvider = useCallback(
		async (provider: PluginConnectOption) => {
			const abortController = new AbortController();
			connectAbortController.current = abortController;
			setError(undefined);
			setConnectingProviderId(provider.providerId);
			try {
				const result = await provider.connectPlugin(requestTextInput, {
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
		[dialog, requestTextInput, show]
	);

	if (
		selectedProvider?.kind === "api-key" ||
		selectedProvider?.kind === "api-key-with-model-discovery"
	) {
		const submit = async (
			apiKey: string,
			signal: AbortSignal
		): Promise<void> => {
			await selectedProvider.connectApiKey(apiKey, { signal });
			if (signal.aborted) {
				return;
			}
			dialog.close();
			show({
				message:
					selectedProvider.kind === "api-key-with-model-discovery"
						? (selectedProvider.successMessage ??
							`${selectedProvider.displayName} connected and Known Models refreshed.`)
						: `${selectedProvider.displayName} API key saved to the Provider SDK.`,
				variant: "success",
			});
		};
		const placeholder =
			selectedProvider.kind === "api-key-with-model-discovery"
				? (selectedProvider.inputPrompt ??
					`Paste ${selectedProvider.displayName} API key`)
				: `Paste ${selectedProvider.displayName} API key`;
		return (
			<ProviderApiKeyDialogContent
				maskInput
				onSubmit={submit}
				placeholder={placeholder}
				provider={{
					displayName: selectedProvider.displayName,
					methods: ["api-key"],
				}}
			/>
		);
	}

	if (selectedProvider?.kind === "oauth") {
		return (
			<ProviderOAuthProgress
				displayName={selectedProvider.displayName}
				error={error}
				status={oauthStatus}
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
				} else if (provider.kind === "oauth") {
					void connectOAuthProvider(provider);
				}
			}}
			providers={providers}
		/>
	);
};
