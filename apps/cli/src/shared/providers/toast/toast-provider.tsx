import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { SplitBorderChars } from "../../constants";
import { useTheme } from "../theme/theme-provider";
import type { ToastOptions, ToastVariant } from "./types";
import { DEFAULT_DURATION } from "./types";

export type ToastContextValue = {
	show: (options: ToastOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
	const value = useContext(ToastContext);
	if (!value) {
		throw new Error("useToast must be used within a ToastProvider");
	}

	return value;
}

type ToastProviderProps = {
	children: ReactNode;
};

export function ToastProvider({ children }: ToastProviderProps) {
	const [currentToast, setCurrentToast] = useState<ToastOptions | null>(null);
	const timeoutHandleRef = useRef<NodeJS.Timeout | null>(null);

	const clearCurrentTimeout = useCallback(() => {
		if (timeoutHandleRef.current) {
			clearTimeout(timeoutHandleRef.current);
			timeoutHandleRef.current = null;
		}
	}, []);

	const show = useCallback(
		(options: ToastOptions) => {
			const duration = options.duration ?? DEFAULT_DURATION;

			clearCurrentTimeout();

			setCurrentToast({
				variant: options.variant ?? "info",
				...options,
				duration,
			});

			timeoutHandleRef.current = setTimeout(() => {
				setCurrentToast(null);
			}, duration).unref();
		},
		[clearCurrentTimeout]
	);

	const value = useMemo(() => ({ show }), [show]);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<Toast currentToast={currentToast} />
		</ToastContext.Provider>
	);
}

type ToastProps = {
	currentToast: ToastOptions | null;
};

function Toast({ currentToast }: ToastProps) {
	const { width } = useTerminalDimensions();
	const { colors } = useTheme();

	if (!currentToast) {
		return null;
	}

	const variantColors: Record<ToastVariant, string> = {
		success: colors.success,
		error: colors.error,
		info: colors.info,
	};

	const borderColor = currentToast.variant
		? variantColors[currentToast.variant]
		: variantColors.info;

	return (
		<box
			position="absolute"
			right={2}
			top={2}
			width={Math.max(1, Math.min(currentToast.width ?? 60, width - 6))}
		>
			<BorderedContentBlock
				border={["left", "right"]}
				borderColor={borderColor}
				colors={colors}
				contentBackgroundColor={colors.backgroundMenu}
				customBorderChars={SplitBorderChars}
				marginBottom={0}
				paddingX={2}
				paddingY={1}
			>
				<text fg={colors.text} width="100%" wrapMode="word">
					{currentToast.message}
				</text>
			</BorderedContentBlock>
		</box>
	);
}
