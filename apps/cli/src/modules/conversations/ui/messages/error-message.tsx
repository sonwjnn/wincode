import { TextAttributes } from "@opentui/core";
import { z } from "zod";
import { EmptyBorder } from "@/shared/constants";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const unauthorizedPattern = /\bunauthorized\b/i;
const providerErrorSchema = z.object({
	error: z.object({ message: z.string().min(1) }).optional(),
});

type ErrorMessageProps = {
	error: unknown;
};

const getProviderErrorMessage = (error: unknown): string | undefined => {
	if (
		typeof error !== "object" ||
		error === null ||
		!("responseBody" in error) ||
		typeof error.responseBody !== "string"
	) {
		return;
	}

	try {
		return providerErrorSchema.safeParse(JSON.parse(error.responseBody)).data
			?.error?.message;
	} catch {
		return;
	}
};

export const getDisplayMessage = (error: unknown): string => {
	const message =
		getProviderErrorMessage(error) ??
		(error instanceof Error ? error.message : "Chat request failed.");

	return unauthorizedPattern.test(message)
		? "Wincode session invalid or expired. Run /connect to sign in again."
		: message;
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
