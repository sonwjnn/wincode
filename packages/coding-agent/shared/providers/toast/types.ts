export type ToastVariant = "success" | "error" | "info";

export type UiNotificationLevel = ToastVariant | "warning";

export type UiNotificationAnchor = Readonly<{
	messageCount: number;
	timelineItemCount: number;
	afterMessageId?: string;
	afterCompactionId?: string;
}>;

export type UiNotification = Readonly<{
	id: number;
	level: UiNotificationLevel;
	message: string;
	anchor?: UiNotificationAnchor;
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
