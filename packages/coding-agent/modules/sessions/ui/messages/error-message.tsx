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
const authenticationGuidanceFor = (error: unknown): string | undefined => {
	if (isOperationalFailure(error)) {
		if (error.code !== "authentication" && error.code !== "authorization") {
			return;
		}
		if (error.source !== "model") {
			return "Authentication failed. Check the relevant account or Provider connection in /connect.";
		}
		const identity = [error.details?.providerId, error.details?.modelId]
			.filter(isString)
			.join("/");
		return identity.length > 0
			? `Authentication failed for ${identity}. Check that Provider connection in /connect.`
			: "Provider authentication failed. Check the selected Provider connection in /connect.";
	}
	if (!hasProviderDiagnostics(error)) {
		return;
	}
	const { code } = normalizeModelFailure(error);
	return code === "authentication" || code === "authorization"
		? "Provider authentication failed. Check the selected Provider connection in /connect."
		: undefined;
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

	const authenticationGuidance = authenticationGuidanceFor(error);
	if (!isUndefined(authenticationGuidance)) {
		return authenticationGuidance;
	}
	if (unauthorizedPattern.test(message)) {
		return "Authentication failed. Check the relevant account or Provider connection in /connect.";
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
