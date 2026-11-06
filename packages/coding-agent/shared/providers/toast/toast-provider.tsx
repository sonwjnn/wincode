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
import { useTheme } from "../theme/theme-provider";
import type {
	ToastOptions,
	ToastVariant,
	UiNotification,
	UiNotificationAnchor,
	UiNotificationLevel,
	UiStatus,
} from "./types";
import { DEFAULT_DURATION } from "./types";

export type ToastContextValue = {
	show: (options: ToastOptions) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

type SessionNotificationStore = Readonly<{
	notificationsByScope: ReadonlyMap<string, readonly UiNotification[]>;
	statusesByScope: ReadonlyMap<string, readonly UiStatus[]>;
	notify: (
		scope: string,
		message: string,
		level: UiNotificationLevel,
		anchor?: UiNotificationAnchor
	) => void;
	setStatus: (scope: string, key: string, message: string | undefined) => void;
	clearScope: (scope: string) => void;
}>;

const SessionNotificationContext =
	createContext<SessionNotificationStore | null>(null);
const EMPTY_UI_NOTIFICATIONS: readonly UiNotification[] = [];
const EMPTY_UI_STATUSES: readonly UiStatus[] = [];

export type SessionNotifications = Readonly<{
	notifications: readonly UiNotification[];
	statuses: readonly UiStatus[];
	notify: (
		message: string,
		level?: UiNotificationLevel,
		anchor?: UiNotificationAnchor
	) => void;
	setStatus: (key: string, message: string | undefined) => void;
	clear: () => void;
}>;

export function useToast(): ToastContextValue {
	const value = useContext(ToastContext);
	if (!value) {
		throw new Error("useToast must be used within a ToastProvider");
	}

	return value;
}

export function useSessionNotifications(scope: string): SessionNotifications {
	const store = useContext(SessionNotificationContext);
	if (store === null) {
		throw new Error(
			"useSessionNotifications must be used within a ToastProvider"
		);
	}
	const notify = useCallback(
		(
			message: string,
			level: UiNotificationLevel = "info",
			anchor?: UiNotificationAnchor
		) => store.notify(scope, message, level, anchor),
		[scope, store.notify]
	);
	const setStatus = useCallback(
		(key: string, message: string | undefined) =>
			store.setStatus(scope, key, message),
		[scope, store.setStatus]
	);
	const clear = useCallback(
		() => store.clearScope(scope),
		[scope, store.clearScope]
	);
	const notifications =
		store.notificationsByScope.get(scope) ?? EMPTY_UI_NOTIFICATIONS;
	const statuses = store.statusesByScope.get(scope) ?? EMPTY_UI_STATUSES;
	return useMemo(
		() => ({ clear, notifications, setStatus, statuses, notify }),
		[clear, notifications, notify, setStatus, statuses]
	);
}

type ToastProviderProps = {
	children: ReactNode;
};

export function ToastProvider({ children }: ToastProviderProps) {
	const [currentToast, setCurrentToast] = useState<ToastOptions | null>(null);
	const [notificationsByScope, setNotificationsByScope] = useState<
		ReadonlyMap<string, readonly UiNotification[]>
	>(() => new Map());
	const [statusesByScope, setStatusesByScope] = useState<
		ReadonlyMap<string, readonly UiStatus[]>
	>(() => new Map());
	const nextNotificationIdRef = useRef(0);
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

	const notify = useCallback(
		(
			scope: string,
			message: string,
			level: UiNotificationLevel,
			anchor?: UiNotificationAnchor
		): void => {
			const id = ++nextNotificationIdRef.current;
			setNotificationsByScope((current) => {
				const scopedNotifications = current.get(scope) ?? [];
				const last = scopedNotifications.at(-1);
				const sameAnchor =
					last?.anchor?.messageCount === anchor?.messageCount &&
					last?.anchor?.timelineItemCount === anchor?.timelineItemCount &&
					last?.anchor?.afterMessageId === anchor?.afterMessageId &&
					last?.anchor?.afterCompactionId === anchor?.afterCompactionId;
				const nextNotification: UiNotification = {
					id,
					level,
					message,
					...(anchor === undefined ? {} : { anchor }),
				};
				const nextScopedNotifications =
					level === "info" && last?.level === "info" && sameAnchor
						? [...scopedNotifications.slice(0, -1), { ...last, message }]
						: [...scopedNotifications, nextNotification];
				return new Map(current).set(scope, nextScopedNotifications);
			});
		},
		[]
	);
	const setStatus = useCallback(
		(scope: string, key: string, message: string | undefined): void => {
			setStatusesByScope((current) => {
				const scopedStatuses = current.get(scope) ?? [];
				const index = scopedStatuses.findIndex((status) => status.key === key);
				if (message === undefined && index === -1) {
					return current;
				}
				const existing = scopedStatuses[index];
				if (existing?.message === message) {
					return current;
				}
				let nextScopedStatuses: readonly UiStatus[];
				if (message === undefined) {
					nextScopedStatuses = scopedStatuses.filter(
						(status) => status.key !== key
					);
				} else if (index === -1) {
					nextScopedStatuses = [...scopedStatuses, { key, message }];
				} else {
					nextScopedStatuses = scopedStatuses.map((status) =>
						status.key === key ? { ...status, message } : status
					);
				}
				const next = new Map(current);
				if (nextScopedStatuses.length === 0) {
					next.delete(scope);
				} else {
					next.set(scope, nextScopedStatuses);
				}
				return next;
			});
		},
		[]
	);
	const clearScope = useCallback((scope: string): void => {
		setNotificationsByScope((current) => {
			if (!current.has(scope)) {
				return current;
			}
			const next = new Map(current);
			next.delete(scope);
			return next;
		});
		setStatusesByScope((current) => {
			if (!current.has(scope)) {
				return current;
			}
			const next = new Map(current);
			next.delete(scope);
			return next;
		});
	}, []);
	const value = useMemo(() => ({ show }), [show]);
	const sessionNotificationStore = useMemo(
		() => ({
			clearScope,
			notificationsByScope,
			notify,
			setStatus,
			statusesByScope,
		}),
		[clearScope, notificationsByScope, notify, setStatus, statusesByScope]
	);

	return (
		<ToastContext.Provider value={value}>
			<SessionNotificationContext.Provider value={sessionNotificationStore}>
				{children}
				<Toast currentToast={currentToast} />
			</SessionNotificationContext.Provider>
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

	return (
		<box
			position="absolute"
			right={2}
			top={2}
			width={Math.max(1, Math.min(currentToast.width ?? 60, width - 6))}
		>
			<box backgroundColor={colors.backgroundMenu} paddingX={2} paddingY={1}>
				<text
					fg={variantColors[currentToast.variant ?? "info"]}
					width="100%"
					wrapMode="word"
				>
					{currentToast.message}
				</text>
			</box>
		</box>
	);
}
