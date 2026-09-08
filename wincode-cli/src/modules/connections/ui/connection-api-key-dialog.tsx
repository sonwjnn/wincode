import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import type { ConnectionProviderSummary } from "../contract";

type ConnectionApiKeyDialogContentProps = {
	provider: ConnectionProviderSummary;
	onSubmit: (apiKey: string, signal: AbortSignal) => void | Promise<void>;
	placeholder?: string;
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return "Failed to save API key.";
}

export function ConnectionApiKeyDialogContent({
	provider,
	onSubmit,
	placeholder = "Paste API key",
}: ConnectionApiKeyDialogContentProps) {
	const inputRef = useRef<InputRenderable>(null);
	const isSubmittingRef = useRef(false);
	const submissionControllerRef = useRef<AbortController | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();
	const description =
		provider.methods.length === 1 && provider.methods[0] === "api-key"
			? `${provider.displayName} only supports API key sign-in.`
			: "Paste an API key to connect.";

	const handleSubmit = useCallback(async () => {
		if (isSubmittingRef.current) {
			return;
		}

		const apiKey = (inputRef.current?.value ?? "").trim();
		if (!apiKey) {
			return;
		}

		isSubmittingRef.current = true;
		submissionControllerRef.current?.abort();
		const controller = new AbortController();
		submissionControllerRef.current = controller;
		setIsSubmitting(true);
		setError(null);

		try {
			await onSubmit(apiKey, controller.signal);
			if (!controller.signal.aborted && inputRef.current) {
				inputRef.current.value = "";
			}
		} catch (submitError) {
			if (!controller.signal.aborted) {
				setError(getErrorMessage(submitError));
			}
		} finally {
			if (submissionControllerRef.current === controller) {
				submissionControllerRef.current = null;
			}
			isSubmittingRef.current = false;
			setIsSubmitting(false);
		}
	}, [onSubmit]);

	useEffect(() => () => submissionControllerRef.current?.abort(), []);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			handleSubmit().catch(() => undefined);
		}
	});

	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<text
				attributes={TextAttributes.DIM}
				fg={colors.textMuted}
				selectable={false}
			>
				{description}
			</text>
			<input
				focused
				focusedTextColor={colors.text}
				onContentChange={() => {
					setError(null);
				}}
				placeholder={placeholder}
				placeholderColor={colors.textMuted}
				ref={inputRef}
				textColor={colors.text}
			/>
			{error ? <text fg={colors.error}>{error}</text> : null}
			<box flexDirection="row" gap={2} height={1}>
				<DialogFooterHint
					label={isSubmitting ? "saving" : "save key"}
					shortcut={isSubmitting ? "..." : "enter"}
				/>
			</box>
		</box>
	);
}
