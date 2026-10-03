import { useKeyboard } from "@opentui/react";
import {
	getErrorMessage,
	isDebugMode,
	isError,
	isString,
	resolveLogFilePath,
} from "@wincode/runtime-utils";
import { useEffect, useState } from "react";
import { useLatest } from "@/shared/hooks/use-latest";
import { useErrorRecovery } from "@/shared/providers/error-recovery/error-recovery-provider";
import { useOptionalKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	logUnhandledUiError,
	type UiErrorScope,
} from "@/shared/utils/ui-error-log";

const FALLBACK_LAYER_ID = "error-fallback";
const EXIT_AFTER_UI_ERROR = 1;
const MAX_OCCURRENCE_KEYS = 64;

const occurrenceCounts = new Map<string, number>();

const occurrenceKey = (error: unknown, scope: UiErrorScope): string | null => {
	if (isError(error)) {
		return `${scope}\u0000${error.name}: ${error.message}`;
	}
	if (isString(error)) {
		return `${scope}\u0000string: ${error}`;
	}
	return null;
};

const countOccurrence = (error: unknown, scope: UiErrorScope): number => {
	const key = occurrenceKey(error, scope);
	if (key === null) {
		return 1;
	}
	if (occurrenceCounts.size >= MAX_OCCURRENCE_KEYS) {
		occurrenceCounts.clear();
	}
	const count = (occurrenceCounts.get(key) ?? 0) + 1;
	occurrenceCounts.set(key, count);
	return count;
};

type ErrorFallbackViewProps = {
	error: unknown;
	reset: () => void;
	scope: UiErrorScope;
};

/**
 * The user-facing screen for any error caught by an error boundary: keep the
 * session, offer a retry, and point at the diagnostics file. `Enter` resets
 * the failed subtree, `Esc`/`Ctrl+C` quit with a non-zero status.
 */
export function ErrorFallbackView({
	error,
	reset,
	scope,
}: ErrorFallbackViewProps) {
	const { colors } = useTheme();
	const { quit } = useErrorRecovery();
	const keyboardLayer = useOptionalKeyboardLayer();
	const quitLatest = useLatest(quit);
	const [occurrence, setOccurrence] = useState(1);
	useEffect(() => {
		// Count committed mounts only: React discards some concurrent renders, so
		// counting during render would over-report.
		const count = countOccurrence(error, scope);
		if (count > 1) {
			setOccurrence(count);
		}
	}, [error, scope]);

	// Depend on the stable push/pop callbacks, not the context object: the
	// provider recreates its value on every render, and re-registering from an
	// effect keyed on that value would loop.
	const pushLayer = keyboardLayer?.push;
	const popLayer = keyboardLayer?.pop;
	useEffect(() => {
		if (pushLayer === undefined || popLayer === undefined) {
			return;
		}
		// The top layer swallows Ctrl+C from the provider's responder chain.
		pushLayer(FALLBACK_LAYER_ID, () => {
			quitLatest.current(EXIT_AFTER_UI_ERROR);
			return true;
		});
		return () => {
			popLayer(FALLBACK_LAYER_ID);
		};
	}, [popLayer, pushLayer]);

	useKeyboard((key) => {
		if (
			keyboardLayer !== null &&
			!keyboardLayer.isTopLayer(FALLBACK_LAYER_ID)
		) {
			return;
		}
		if (key.ctrl && key.name === "c") {
			// Without a keyboard layer nothing else handles Ctrl+C; with one the
			// layer responder above owns it.
			if (keyboardLayer === null) {
				key.preventDefault();
				quit(EXIT_AFTER_UI_ERROR);
			}
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			quit(EXIT_AFTER_UI_ERROR);
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			reset();
		}
	});

	if (isDebugMode()) {
		logUnhandledUiError(error, scope);
		throw error;
	}

	const message = getErrorMessage(error, "Unexpected UI error.");
	const logPath = resolveLogFilePath();
	return (
		<box flexDirection="column" gap={1} padding={1}>
			<text fg={colors.error}>Something went wrong</text>
			<text fg={colors.text}>{message}</text>
			{occurrence > 1 ? (
				<text fg={colors.textMuted}>
					This error has occurred {occurrence} times.
				</text>
			) : null}
			<text fg={colors.textMuted}>Press Enter to continue, Esc to quit.</text>
			<text fg={colors.textMuted}>Log: {logPath}</text>
		</box>
	);
}
