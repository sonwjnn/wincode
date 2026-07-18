import { useCallback, useState } from "react";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useConnections } from "../context/connections-provider";
import {
	type ConnectionProviderSummary,
	connectionProviderDisplayNames,
	isBrowserCapableProvider,
} from "../contract";
import { ConnectionApiKeyDialogContent } from "./connection-api-key-dialog";
import { ConnectionBrowserWaitingDialogContent } from "./connection-browser-waiting-dialog";
import type { ConnectionMethodId } from "./connection-dialog-options";
import { ConnectionMethodPickerDialogContent } from "./connection-method-picker-dialog";
import { ConnectionProviderPickerDialogContent } from "./connection-provider-picker-dialog";

export const CONNECTION_DIALOG_WIDTH = 60;

type BrowserConnectCallbacks = {
	setAuthorizationUrl: (authorizationUrl: string) => void;
	setStatus: (status: string) => void;
	signal: AbortSignal;
};

type ConnectDialogContentProps = {
	connectedProviders: readonly ConnectionProviderSummary[];
	onConnected: (provider: ConnectionProviderSummary) => void;
	onBrowserOpenUrl?: (url: string) => void | Promise<void>;
	onBrowserCopyUrl?: (url: string) => void | Promise<void>;
	onMethodSelect?: (
		providerId: ConnectionProviderSummary["id"],
		methodId: ConnectionMethodId
	) => void;
	onProviderSelect?: (providerId: ConnectionProviderSummary["id"]) => void;
};

const getProviderLabel = (
	provider: ConnectionProviderSummary | undefined
): string =>
	provider?.displayName ??
	(provider ? connectionProviderDisplayNames[provider.id] : "");

const getConnectedProvider = (
	providers: readonly ConnectionProviderSummary[],
	providerId: ConnectionProviderSummary["id"]
): ConnectionProviderSummary => {
	const provider = providers.find((item) => item.id === providerId);
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`);
	}
	return provider;
};

export const connectProviderApiKey = async (
	connections: ReturnType<typeof useConnections>,
	providerId: ConnectionProviderSummary["id"],
	apiKey: string,
	signal?: AbortSignal
): Promise<void> => {
	await connections.connect({
		apiKey,
		method: "api-key",
		providerId,
		signal,
	});
};

export const connectProviderBrowser = async (
	connections: ReturnType<typeof useConnections>,
	provider: ConnectionProviderSummary,
	callbacks: BrowserConnectCallbacks
): Promise<void> => {
	if (!isBrowserCapableProvider(provider)) {
		throw new Error("Browser sign-in unavailable.");
	}
	await connections.connect({
		method: "browser",
		onAuthorizationUrl: (authorizationUrl) =>
			callbacks.setAuthorizationUrl(authorizationUrl.href),
		onProgress: (status) => callbacks.setStatus(status),
		providerId: provider.id,
		signal: callbacks.signal,
	});
};

export function ConnectDialogContent({
	connectedProviders,
	onConnected,
	onBrowserOpenUrl,
	onBrowserCopyUrl,
	onMethodSelect,
	onProviderSelect,
}: ConnectDialogContentProps) {
	const dialog = useDialog();
	const connections = useConnections();
	const [activeProviderIds, setActiveProviderIds] = useState<
		readonly ConnectionProviderSummary["id"][]
	>(() =>
		connectedProviders
			.filter((provider) => provider.connected)
			.map((provider) => provider.id)
	);

	const markProviderConnected = useCallback(
		(providerId: ConnectionProviderSummary["id"]) => {
			setActiveProviderIds((currentProviderIds) =>
				currentProviderIds.includes(providerId)
					? currentProviderIds
					: [...currentProviderIds, providerId]
			);
		},
		[]
	);

	const openMethodDialog = useCallback(
		(providerId: ConnectionProviderSummary["id"]) => {
			const provider = getConnectedProvider(connectedProviders, providerId);
			dialog.open({
				children: (
					<ConnectionMethodPickerDialogContent
						onSelectMethod={(methodId) => {
							onMethodSelect?.(providerId, methodId);
							if (methodId === "api-key") {
								dialog.open({
									children: (
										<ConnectionApiKeyDialogContent
											onSubmit={async (apiKey, signal) => {
												await connectProviderApiKey(
													connections,
													providerId,
													apiKey,
													signal
												);
												if (signal.aborted) {
													return;
												}
												markProviderConnected(providerId);
												onConnected(provider);
												dialog.close();
											}}
											providerId={providerId}
										/>
									),
									title: `${getProviderLabel(provider)} API key`,
									width: CONNECTION_DIALOG_WIDTH,
								});
								return;
							}
							dialog.open({
								children: (
									<ConnectionBrowserWaitingDialogContent
										onBrowserOpenUrl={onBrowserOpenUrl}
										onConnect={async (browserProviderId, callbacks) => {
											const selectedProvider = getConnectedProvider(
												connectedProviders,
												browserProviderId
											);
											await connectProviderBrowser(
												connections,
												selectedProvider,
												callbacks
											);
											markProviderConnected(browserProviderId);
											onConnected(selectedProvider);
										}}
										onCopyUrl={onBrowserCopyUrl}
										providerId={providerId}
									/>
								),
								title: `${getProviderLabel(provider)} browser`,
								width: CONNECTION_DIALOG_WIDTH,
							});
						}}
						provider={provider}
					/>
				),
				padding: { bottom: 1, left: 0, right: 0, top: 1 },
				title: "Choose method",
				titleMargin: { left: 4, right: 4 },
				width: CONNECTION_DIALOG_WIDTH,
			});
		},
		[
			connectedProviders,
			connections,
			dialog,
			markProviderConnected,
			onBrowserCopyUrl,
			onBrowserOpenUrl,
			onConnected,
			onMethodSelect,
		]
	);

	return (
		<ConnectionProviderPickerDialogContent
			connectedProviderIds={activeProviderIds}
			onSelectProvider={(providerId) => {
				onProviderSelect?.(providerId);
				openMethodDialog(providerId);
			}}
			providers={connectedProviders}
		/>
	);
}
