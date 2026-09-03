import { TextAttributes } from "@opentui/core";
import {
	isOperationalFailure,
	normalizeOperationalFailure,
} from "@wincode/agent-core";
import { normalizeModelFailure } from "@wincode/ai/failures";
import { EmptyBorder } from "@/shared/constants";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const unauthorizedPattern = /\bunauthorized\b/i;

type ErrorMessageProps = {
	error: unknown;
};

const hasProviderDiagnostics = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	return (
		("responseBody" in error && typeof error.responseBody === "string") ||
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
		if (providerMessage !== undefined) {
			message = providerMessage;
		} else if (error instanceof Error) {
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

export function ErrorMessage({ error }: ErrorMessageProps) {
	const { colors } = useTheme();
	const displayMessage = getDisplayMessage(error);

	return (
		<box alignItems="center" width="100%">
			<box
				border={["left"]}
				borderColor={colors.error}
				customBorderChars={{
					...EmptyBorder,
					bottomLeft: "╹",
					vertical: "┃",
				}}
				width="100%"
			>
				<box
					backgroundColor={colors.backgroundPanel}
					justifyContent="center"
					paddingBottom={1}
					paddingTop={1}
					paddingX={2}
					width="100%"
				>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						{displayMessage}
					</text>
				</box>
			</box>
		</box>
	);
}
