import { useEffect, useState } from "react";
import { useTerminalDimensions } from "./react-hooks";
import { useTheme } from "./theme";

export type NotificationVariant = "success" | "warning" | "error" | "info";

export type StatusFeedbackProgress = Readonly<{
	current: number;
	total: number;
}>;

export type StatusFeedbackProps =
	| Readonly<{
			message: string;
			progress?: never;
			status: "loading" | "success" | "error";
	  }>
	| Readonly<{
			message: string;
			progress: StatusFeedbackProgress;
			status: "progress";
	  }>;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const PROGRESS_BAR_WIDTH = 8;

/** Presents operation state without deciding whether or when the host clears it. */
export function StatusFeedback(props: StatusFeedbackProps) {
	const { colors } = useTheme();
	const [frameIndex, setFrameIndex] = useState(0);
	useEffect(() => {
		if (props.status !== "loading") {
			setFrameIndex(0);
			return;
		}
		const interval = setInterval(() => {
			setFrameIndex((index) => (index + 1) % SPINNER_FRAMES.length);
		}, SPINNER_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [props.status]);

	const colorByStatus = {
		loading: colors.info,
		progress: colors.info,
		success: colors.success,
		error: colors.error,
	};
	const color = colorByStatus[props.status];
	let indicator: string;
	if (props.status === "loading") {
		indicator = SPINNER_FRAMES[frameIndex] ?? "⠋";
	} else if (props.status === "progress") {
		const ratio =
			props.progress.total > 0
				? Math.max(
						0,
						Math.min(1, props.progress.current / props.progress.total)
					)
				: 0;
		const filledWidth = Math.round(ratio * PROGRESS_BAR_WIDTH);
		indicator = `[${"━".repeat(filledWidth)}${"─".repeat(PROGRESS_BAR_WIDTH - filledWidth)}]`;
	} else {
		indicator = props.status === "success" ? "✓" : "✗";
	}

	return (
		<box alignItems="center" flexDirection="row" gap={1}>
			<text fg={color}>{indicator}</text>
			<text fg={color} wrapMode="word">
				{props.message}
			</text>
		</box>
	);
}

export type NotificationToastProps = Readonly<{
	message: string;
	variant?: NotificationVariant;
	width?: number;
}>;

/** Renders a notification; the caller owns visibility, timing, and dismissal. */
export function NotificationToast({
	message,
	variant = "info",
	width: requestedWidth = 60,
}: NotificationToastProps) {
	const { width } = useTerminalDimensions();
	const { colors } = useTheme();
	const colorByVariant: Record<NotificationVariant, string> = {
		success: colors.success,
		warning: colors.warning,
		error: colors.error,
		info: colors.info,
	};
	const color = colorByVariant[variant];
	const background = colors.backgroundMenu;

	return (
		<box
			position="absolute"
			right={2}
			top={2}
			width={Math.max(1, Math.min(requestedWidth, width - 6))}
		>
			<box
				{...(typeof background === "string"
					? { backgroundColor: background }
					: {})}
				paddingX={2}
				paddingY={1}
			>
				<text fg={color} width="100%" wrapMode="word">
					{message}
				</text>
			</box>
		</box>
	);
}
