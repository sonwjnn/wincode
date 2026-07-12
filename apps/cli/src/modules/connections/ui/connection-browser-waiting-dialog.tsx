import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ProviderId } from "../types";

type BrowserConnectCallbacks = {
	setAuthorizationUrl: (authorizationUrl: string) => void;
	setStatus: (status: string) => void;
	signal: AbortSignal;
};

type ConnectionBrowserWaitingDialogContentProps = {
	providerId: ProviderId;
	onConnect: (
		providerId: ProviderId,
		callbacks: BrowserConnectCallbacks
	) => Promise<void>;
	onBrowserOpenUrl?: (url: string) => void | Promise<void>;
	onCopyUrl?: (url: string) => void | Promise<void>;
};

function getErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "";
	}

	if (error instanceof Error) {
		return error.message;
	}

	return "Browser sign-in failed.";
}

export function ConnectionBrowserWaitingDialogContent({
	providerId,
	onConnect,
	onBrowserOpenUrl,
	onCopyUrl,
}: ConnectionBrowserWaitingDialogContentProps) {
	const [authorizationUrl, setAuthorizationUrl] = useState("");
	const [status, setStatus] = useState("Waiting for browser sign-in.");
	const [error, setError] = useState<string | null>(null);
	const hasStartedRef = useRef(false);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();
	const dialog = useDialog();

	const closeAllDialogs = useCallback(() => {
		dialog.closeAll();
	}, [dialog]);

	const handleCopy = useCallback(async () => {
		if (!authorizationUrl) {
			return;
		}

		try {
			await onCopyUrl?.(authorizationUrl);
		} catch (copyError) {
			setError(getErrorMessage(copyError));
		}
	}, [authorizationUrl, onCopyUrl]);

	const handleOpenUrl = useCallback(async () => {
		if (!authorizationUrl) {
			return;
		}

		if (!onBrowserOpenUrl) {
			return;
		}

		setError(null);
		try {
			await onBrowserOpenUrl(authorizationUrl);
		} catch (openError) {
			setError(getErrorMessage(openError));
		}
	}, [authorizationUrl, onBrowserOpenUrl]);

	useEffect(() => {
		if (hasStartedRef.current) {
			return;
		}

		hasStartedRef.current = true;
		const controller = new AbortController();

		const startConnection = async () => {
			try {
				await onConnect(providerId, {
					setAuthorizationUrl: (nextAuthorizationUrl) => {
						if (!controller.signal.aborted) {
							setAuthorizationUrl(nextAuthorizationUrl);
						}
					},
					setStatus: (nextStatus) => {
						if (!controller.signal.aborted) {
							setStatus(nextStatus);
						}
					},
					signal: controller.signal,
				});
				if (controller.signal.aborted) {
					return;
				}

				setStatus("Connected.");
				closeAllDialogs();
			} catch (connectError) {
				if (controller.signal.aborted) {
					return;
				}

				const message = getErrorMessage(connectError);
				if (!message) {
					return;
				}

				setError(message);
				setStatus("Browser sign-in failed.");
			}
		};

		startConnection().catch(() => undefined);

		return () => {
			controller.abort();
		};
	}, [closeAllDialogs, onConnect, providerId]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}

		if (key.name === "c" && authorizationUrl) {
			key.preventDefault();
			handleCopy().catch(() => undefined);
		}
	});

	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<text selectable={false}>{status}</text>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
			<text
				fg="#58A6FF"
				onMouseDown={() => {
					handleOpenUrl().catch(() => undefined);
				}}
				selectable
				width="100%"
				wrapMode="char"
			>
				{authorizationUrl || "Waiting for browser sign-in..."}
			</text>
			{error ? <text fg={colors.error}>{error}</text> : null}
			<box flexDirection="row" gap={2} height={1}>
				<box flexDirection="row" gap={1}>
					<text>c</text>
					<text attributes={TextAttributes.DIM}>copy</text>
				</box>
			</box>
		</box>
	);
}
