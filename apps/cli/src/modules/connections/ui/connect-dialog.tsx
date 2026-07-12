import { useCallback } from "react";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import type { ProviderId } from "../types";
import { ConnectionApiKeyDialogContent } from "./connection-api-key-dialog";
import { ConnectionBrowserWaitingDialogContent } from "./connection-browser-waiting-dialog";
import {
	CONNECTION_PROVIDERS,
	type ConnectionMethodId,
} from "./connection-dialog-options";
import { ConnectionMethodPickerDialogContent } from "./connection-method-picker-dialog";
import { ConnectionProviderPickerDialogContent } from "./connection-provider-picker-dialog";

export const CONNECTION_DIALOG_WIDTH = 72;

type BrowserConnectCallbacks = {
	setAuthorizationUrl: (authorizationUrl: string) => void;
	setStatus: (status: string) => void;
	signal: AbortSignal;
};

type ConnectDialogContentProps = {
	connectedProviderIds?: readonly ProviderId[];
	onApiKeySubmit?: (
		providerId: ProviderId,
		apiKey: string
	) => void | Promise<void>;
	onBrowserConnect?: (
		providerId: ProviderId,
		callbacks: BrowserConnectCallbacks
	) => Promise<void>;
	onBrowserOpenUrl?: (url: string) => void | Promise<void>;
	onBrowserCopyUrl?: (url: string) => void | Promise<void>;
	onMethodSelect?: (
		providerId: ProviderId,
		methodId: ConnectionMethodId
	) => void;
	onProviderSelect?: (providerId: ProviderId) => void;
};

function getProviderLabel(providerId: ProviderId): string {
	return (
		CONNECTION_PROVIDERS.find((provider) => provider.id === providerId)
			?.label ?? providerId
	);
}

export function ConnectDialogContent({
	connectedProviderIds,
	onApiKeySubmit,
	onBrowserConnect,
	onBrowserOpenUrl,
	onBrowserCopyUrl,
	onMethodSelect,
	onProviderSelect,
}: ConnectDialogContentProps) {
	const dialog = useDialog();

	const openMethodDialog = useCallback(
		(providerId: ProviderId) => {
			dialog.open({
				children: (
					<ConnectionMethodPickerDialogContent
						onSelectMethod={(methodId) => {
							onMethodSelect?.(providerId, methodId);
							if (methodId === "api-key") {
								dialog.open({
									children: (
										<ConnectionApiKeyDialogContent
											onSubmit={(apiKey) =>
												onApiKeySubmit?.(providerId, apiKey)
											}
											providerId={providerId}
										/>
									),
									title: `${getProviderLabel(providerId)} API key`,
									width: CONNECTION_DIALOG_WIDTH,
								});
								return;
							}

							dialog.open({
								children: (
									<ConnectionBrowserWaitingDialogContent
										onBrowserOpenUrl={onBrowserOpenUrl}
										onConnect={async (
											browserProviderId: ProviderId,
											callbacks: BrowserConnectCallbacks
										) => {
											if (!onBrowserConnect) {
												throw new Error("Browser sign-in unavailable.");
											}

											await onBrowserConnect(browserProviderId, callbacks);
										}}
										onCopyUrl={onBrowserCopyUrl}
										providerId={providerId}
									/>
								),
								title: `${getProviderLabel(providerId)} browser`,
								width: CONNECTION_DIALOG_WIDTH,
							});
						}}
						providerId={providerId}
					/>
				),
				title: "Choose method",
				width: CONNECTION_DIALOG_WIDTH,
			});
		},
		[
			dialog,
			onApiKeySubmit,
			onBrowserConnect,
			onBrowserCopyUrl,
			onBrowserOpenUrl,
			onMethodSelect,
		]
	);

	const handleSelectProvider = useCallback(
		(providerId: ProviderId) => {
			onProviderSelect?.(providerId);
			openMethodDialog(providerId);
		},
		[openMethodDialog, onProviderSelect]
	);

	return (
		<ConnectionProviderPickerDialogContent
			connectedProviderIds={connectedProviderIds}
			onSelectProvider={handleSelectProvider}
		/>
	);
}
