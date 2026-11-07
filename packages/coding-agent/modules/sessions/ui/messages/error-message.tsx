import {
	isOperationalFailure,
	normalizeOperationalFailure,
} from "@wincode/agent-core";
import { normalizeModelFailure } from "@wincode/ai";
import { isError, isObjectLike, isString, isUndefined } from "@wincode/utils";
import { CommittedAssistantError } from "@/modules/sessions/committed-assistant-error";
import type { SessionMessage } from "@/modules/sessions/message";
import { useTheme } from "@/shared/providers/theme/theme-provider";

export const getAssistantFailureText = (
	message: SessionMessage | undefined
): string | undefined =>
	message?.role === "assistant" &&
	message.metadata?.terminalOutcome === "failed"
		? message.parts
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n") || "Unknown error"
		: undefined;

const unauthorizedPattern = /\bunauthorized\b/i;

type ErrorMessageProps = {
	error: unknown;
};

export type SessionErrorSource = "turn" | "compaction";

const hasProviderDiagnostics = (error: unknown): boolean => {
	if (!isObjectLike(error)) {
		return false;
	}
	return (
		("responseBody" in error && isString(error.responseBody)) ||
		"statusCode" in error ||
		"status" in error
	);
};

const getProviderErrorMessage = (error: unknown): string | undefined => {
	if (!hasProviderDiagnostics(error)) {
		return;
	}
	return normalizeModelFailure(error).message;
};
const isAuthenticationFailure = (error: unknown): boolean => {
	if (isOperationalFailure(error)) {
		return error.code === "authentication" || error.code === "authorization";
	}
	if (!hasProviderDiagnostics(error)) {
		return false;
	}
	const { code } = normalizeModelFailure(error);
	return code === "authentication" || code === "authorization";
};

export const getDisplayMessage = (error: unknown): string => {
	let message: string;
	if (isOperationalFailure(error)) {
		message = normalizeOperationalFailure(error).message;
	} else {
		const providerMessage = getProviderErrorMessage(error);
		if (!isUndefined(providerMessage)) {
			message = providerMessage;
		} else if (isError(error)) {
			message = error.message;
		} else {
			message = normalizeOperationalFailure(error).message;
		}
	}

	if (unauthorizedPattern.test(message) || isAuthenticationFailure(error)) {
		return "Wincode session invalid or expired. Run /connect to sign in again.";
	}
	return message;
};

export const repeatsTerminalError = (
	error: unknown,
	messages: readonly SessionMessage[],
	source: SessionErrorSource | undefined
): boolean => {
	if (source !== "turn" || !(error instanceof CommittedAssistantError)) {
		return false;
	}
	const failureText = getAssistantFailureText(
		messages.find((message) => message.id === error.assistantMessageId)
	);
	return (
		failureText !== undefined &&
		getDisplayMessage(error) === getDisplayMessage(new Error(failureText))
	);
};

export function ErrorMessage({ error }: ErrorMessageProps) {
	const { colors } = useTheme();
	const displayMessage = getDisplayMessage(error);

	return (
		<box paddingX={1} width="100%">
			<text fg={colors.error} width="100%" wrapMode="word">
				{`Error: ${displayMessage}`}
			</text>
		</box>
	);
}
