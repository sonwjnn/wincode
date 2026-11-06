export type ToastVariant = "success" | "error" | "info";

export type UiNotificationLevel = ToastVariant | "warning";

export type UiNotification = Readonly<{
	id: number;
	level: UiNotificationLevel;
	message: string;
}>;

export type UiStatus = Readonly<{
	key: string;
	message: string;
}>;

export type ToastOptions = {
	message: string;
	variant?: ToastVariant;
	duration?: number;
	width?: number;
};

export const DEFAULT_DURATION = 3000;
