import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import {
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ProviderId } from "../types";

type ConnectionApiKeyDialogContentProps = {
	providerId: ProviderId;
	onSubmit: (apiKey: string) => void | Promise<void>;
	placeholder?: string;
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return "Failed to save API key.";
}

export function ConnectionApiKeyDialogContent({
	providerId,
	onSubmit,
	placeholder = "Paste API key",
}: ConnectionApiKeyDialogContentProps) {
	const inputRef = useRef<InputRenderable>(null);
	const isSubmittingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	const handleSubmit = useCallback(async () => {
		if (isSubmittingRef.current) {
			return;
		}

		const apiKey = (inputRef.current?.value ?? "").trim();
		if (!apiKey) {
			return;
		}

		isSubmittingRef.current = true;
		setIsSubmitting(true);
		setError(null);

		try {
			await onSubmit(apiKey);
			if (inputRef.current) {
				inputRef.current.value = "";
			}
		} catch (submitError) {
			setError(getErrorMessage(submitError));
		} finally {
			isSubmittingRef.current = false;
			setIsSubmitting(false);
		}
	}, [onSubmit]);

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
			<text attributes={TextAttributes.DIM} selectable={false}>
				{providerId === "anthropic"
					? "Anthropic only supports API key sign-in."
					: "Paste an API key to connect."}
			</text>
			<input
				focused
				onContentChange={() => {
					setError(null);
				}}
				placeholder={placeholder}
				ref={inputRef}
			/>
			{error ? <text fg={colors.error}>{error}</text> : null}
			<box flexDirection="row" gap={2} height={1}>
				<text>{isSubmitting ? "..." : "enter"}</text>
				<text attributes={TextAttributes.DIM}>
					{isSubmitting ? "saving" : "save key"}
				</text>
			</box>
		</box>
	);
}
