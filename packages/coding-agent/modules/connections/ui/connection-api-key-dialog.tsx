import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ConnectionProviderSummary } from "@wincode/ai/connections";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { DialogInset } from "@/shared/ui/dialog-inset";

type ConnectionApiKeyDialogContentProps = {
	maskInput?: boolean;
	provider: Pick<ConnectionProviderSummary, "displayName" | "methods">;
	onSubmit: (apiKey: string, signal: AbortSignal) => void | Promise<void>;
	placeholder?: string;
};

export function ConnectionApiKeyDialogContent({
	maskInput = false,
	provider,
	onSubmit,
	placeholder = "Paste API key",
}: ConnectionApiKeyDialogContentProps) {
	const inputRef = useRef<InputRenderable>(null);
	const apiKeyRef = useRef("");
	const isMaskingInputRef = useRef(false);
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

		const apiKey = (
			maskInput ? apiKeyRef.current : (inputRef.current?.value ?? "")
		).trim();
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
				apiKeyRef.current = "";
				inputRef.current.value = "";
			}
		} catch (submitError) {
			if (!controller.signal.aborted) {
				setError(getErrorMessage(submitError, "Failed to save API key."));
			}
		} finally {
			if (submissionControllerRef.current === controller) {
				submissionControllerRef.current = null;
			}
			isSubmittingRef.current = false;
			setIsSubmitting(false);
		}
	}, [maskInput, onSubmit]);

	const handleContentChange = useCallback(() => {
		setError(null);
		if (!maskInput || isMaskingInputRef.current) {
			return;
		}
		const input = inputRef.current;
		if (input === null) {
			return;
		}

		const previousMask = "•".repeat(apiKeyRef.current.length);
		const currentValue = input.value;
		let commonPrefix = 0;
		while (
			commonPrefix < previousMask.length &&
			commonPrefix < currentValue.length &&
			previousMask[commonPrefix] === currentValue[commonPrefix]
		) {
			commonPrefix += 1;
		}
		let commonSuffix = 0;
		while (
			commonSuffix < previousMask.length - commonPrefix &&
			commonSuffix < currentValue.length - commonPrefix &&
			previousMask.at(-commonSuffix - 1) === currentValue.at(-commonSuffix - 1)
		) {
			commonSuffix += 1;
		}

		const removedLength = previousMask.length - commonPrefix - commonSuffix;
		const insertedText = currentValue.slice(
			commonPrefix,
			currentValue.length - commonSuffix
		);
		apiKeyRef.current =
			apiKeyRef.current.slice(0, commonPrefix) +
			insertedText +
			apiKeyRef.current.slice(commonPrefix + removedLength);
		const cursorOffset = commonPrefix + insertedText.length;

		isMaskingInputRef.current = true;
		input.value = "•".repeat(apiKeyRef.current.length);
		input.cursorOffset = cursorOffset;
		isMaskingInputRef.current = false;
	}, [maskInput]);

	useEffect(() => () => submissionControllerRef.current?.abort(), []);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

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
		<DialogInset>
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
					id="connection-api-key-input"
					onContentChange={handleContentChange}
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
		</DialogInset>
	);
}
