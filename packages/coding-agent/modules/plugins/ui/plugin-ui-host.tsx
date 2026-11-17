import type {
	InputRenderable,
	SelectRenderable,
	TextareaRenderable,
} from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react";
import { isUndefined, logger } from "@wincode/utils";
import {
	Component,
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
import type { DialogContextValue } from "../../../shared/providers/dialog/dialog-provider";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "../../../shared/providers/dialog/dialog-provider";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../../shared/providers/keyboard-layer/constants";
import {
	type KeyboardLayerContextValue,
	useKeyboardLayer,
} from "../../../shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "../../../shared/providers/theme/theme-provider";
import type { Theme } from "../../../shared/providers/theme/themes";
import {
	findThemeByName,
	THEMES,
} from "../../../shared/providers/theme/themes";
import type { ToastContextValue } from "../../../shared/providers/toast/toast-provider";
import { useToast } from "../../../shared/providers/toast/toast-provider";
import { DialogFooterHint } from "../../../shared/ui/dialog-footer-hint";
import { DialogInset } from "../../../shared/ui/dialog-inset";
import type {
	PluginNotificationLevel,
	PluginThemeChangeResult,
	PluginUI,
	PluginUICustomComponent,
	PluginUICustomContext,
	PluginUICustomFactory,
	PluginUICustomOptions,
	PluginUIDialogOptions,
	PluginUIPromptKind,
} from "../public";
import { PluginUICustomError } from "../public";
import type { PluginRuntime } from "../runtime";

type PluginUIOwner = Readonly<{
	pluginId: string;
	sessionId?: string;
}>;

type PluginUIHandle = Readonly<{
	close: () => void;
	ui: PluginUI;
}>;

type PluginUIKeyboardLayer = Pick<
	KeyboardLayerContextValue,
	"registerShortcut" | "registerTerminalInput"
>;

const keyboardOwnerId = (owner: PluginUIOwner): string =>
	`${owner.sessionId ?? "process"}:${owner.pluginId}`;

type PluginUICustomHostRequest = Readonly<{
	dismiss: () => void;
	done: (value: unknown) => void;
	factory: (
		context: PluginUICustomContext<unknown>
	) =>
		| PluginUICustomComponent<unknown>
		| Promise<PluginUICustomComponent<unknown>>;
	fail: (error: unknown) => void;
	id: string;
	sessionId: string;
	signal: AbortSignal;
	title: string;
}>;

type PluginUICustomStore = Readonly<{
	clear: (requestId: string) => void;
	get: () => PluginUICustomHostRequest | null;
	set: (request: PluginUICustomHostRequest | null) => void;
	subscribe: (listener: () => void) => () => void;
}>;

const createPluginUICustomStore = (): PluginUICustomStore => {
	let current: PluginUICustomHostRequest | null = null;
	const listeners = new Set<() => void>();
	return Object.freeze({
		clear(requestId) {
			if (current?.id === requestId) {
				current = null;
			}
		},
		get: () => current,
		set(request) {
			if (current === request) {
				return;
			}
			current = request;
			for (const listener of [...listeners]) {
				listener();
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
};

const EMPTY_PLUGIN_CUSTOM_UI = createPluginUICustomStore();

export type PluginUIHost = Readonly<{
	close: () => void;
	registerShortcut: (
		owner: PluginUIOwner,
		shortcut: string,
		handler: () => void
	) => () => void;
	create: (
		owner: PluginUIOwner,
		beginPrompt: (kind: PluginUIPromptKind, title: string) => () => void,
		invocation: "command" | "event"
	) => PluginUIHandle;
	getCustomUI: () => PluginUICustomHostRequest | null;
	subscribeCustomUI: (listener: () => void) => () => void;
}>;

type PluginUIHostDependencies = Readonly<{
	customUI: PluginUICustomStore;
	dialog: () => DialogContextValue;
	keyboardLayer: () => PluginUIKeyboardLayer;
	theme: () => Readonly<{ setTheme: (theme: Theme) => void }>;
	toast: () => ToastContextValue;
}>;

type PluginDialogRequestProps = Readonly<{
	children?: ReactNode;
	onDismiss: () => void;
}>;

const PluginDialogRequest = ({
	children,
	onDismiss,
}: PluginDialogRequestProps) => {
	useDialogEscape();
	useEffect(() => () => onDismiss(), [onDismiss]);
	return children;
};

type PluginSelectDialogProps = Readonly<{
	choices: readonly string[];
	onResolve: (value: string | undefined) => void;
	prompt: string;
}>;

const PluginSelectDialog = ({
	choices,
	onResolve,
	prompt,
}: PluginSelectDialogProps) => {
	const selectRef = useRef<SelectRenderable>(null);
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const isActiveLayer = isTopLayer(layerId);

	useEffect(() => {
		if (isActiveLayer) {
			selectRef.current?.focus();
		}
	}, [isActiveLayer]);

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<text fg={colors.text} selectable={false} wrapMode="word">
					{prompt}
				</text>
				<select
					focused
					onSelect={(_index, option) => onResolve(option?.name)}
					options={choices.map((name) => ({ description: "", name }))}
					ref={selectRef}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={1}>
					<DialogFooterHint label="select" shortcut="enter" />
					<DialogFooterHint label="cancel" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};

type PluginConfirmDialogProps = Readonly<{
	message?: string;
	onResolve: (value: boolean) => void;
}>;

const PluginConfirmDialog = ({
	message,
	onResolve,
}: PluginConfirmDialogProps) => {
	const selectRef = useRef<SelectRenderable>(null);
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const isActiveLayer = isTopLayer(layerId);

	useEffect(() => {
		if (isActiveLayer) {
			selectRef.current?.focus();
		}
	}, [isActiveLayer]);

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				{message === undefined ? null : (
					<text fg={colors.text} selectable={false} wrapMode="word">
						{message}
					</text>
				)}
				<select
					focused
					onSelect={(index) => onResolve(index === 0)}
					options={[
						{ description: "", name: "Yes" },
						{ description: "", name: "No" },
					]}
					ref={selectRef}
					selectedIndex={1}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={1}>
					<DialogFooterHint label="confirm" shortcut="enter" />
					<DialogFooterHint label="cancel" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};

type PluginInputDialogProps = Readonly<{
	onResolve: (value: string | undefined) => void;
	placeholder?: string;
}>;

const PluginInputDialog = ({
	onResolve,
	placeholder,
}: PluginInputDialogProps) => {
	const inputRef = useRef<InputRenderable>(null);
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const isActiveLayer = isTopLayer(layerId);

	useEffect(() => {
		if (isActiveLayer) {
			inputRef.current?.focus();
		}
	}, [isActiveLayer]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			onResolve(inputRef.current?.value ?? "");
		}
	});

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<input
					focused
					focusedTextColor={colors.text}
					onContentChange={() => undefined}
					placeholder={placeholder}
					ref={inputRef}
					textColor={colors.text}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={1}>
					<DialogFooterHint label="submit" shortcut="enter" />
					<DialogFooterHint label="cancel" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};

type PluginEditorDialogProps = Readonly<{
	initialValue: string;
	onResolve: (value: string | undefined) => void;
}>;

const PluginEditorDialog = ({
	initialValue,
	onResolve,
}: PluginEditorDialogProps) => {
	const textareaRef = useRef<TextareaRenderable>(null);
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const isActiveLayer = isTopLayer(layerId);

	useEffect(() => {
		if (isActiveLayer) {
			textareaRef.current?.focus();
		}
	}, [isActiveLayer]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.ctrl && (key.name === "enter" || key.name === "return")) {
			key.preventDefault();
			onResolve(textareaRef.current?.plainText ?? initialValue);
		}
	});

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<textarea
					focused
					focusedTextColor={colors.text}
					height={10}
					initialValue={initialValue}
					onContentChange={() => undefined}
					ref={textareaRef}
					textColor={colors.text}
					wrapMode="word"
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={1}>
					<DialogFooterHint label="save" shortcut="ctrl+enter" />
					<DialogFooterHint label="cancel" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};

type PluginUICustomInvitationProps = Readonly<{
	pluginId: string;
	title: string;
	onAccept: () => void;
	onDecline: () => void;
}>;

const PluginUICustomInvitation = ({
	pluginId,
	title,
	onAccept,
	onDecline,
}: PluginUICustomInvitationProps) => {
	const selectRef = useRef<SelectRenderable>(null);
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const isActiveLayer = isTopLayer(layerId);

	useEffect(() => {
		if (isActiveLayer) {
			selectRef.current?.focus();
		}
	}, [isActiveLayer]);

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<text fg={colors.text} selectable={false} wrapMode="word">
					{`Plugin '${pluginId}' requests permission to open a custom UI: ${title}`}
				</text>
				<select
					focused
					onSelect={(index) => (index === 0 ? onAccept() : onDecline())}
					options={[
						{ description: "", name: "Allow once" },
						{ description: "", name: "Decline" },
					]}
					ref={selectRef}
					selectedIndex={1}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={1}>
					<DialogFooterHint label="accept" shortcut="enter" />
					<DialogFooterHint label="decline" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};

class PluginUICustomErrorBoundary extends Component<
	Readonly<{ children: ReactNode; onError: (error: Error) => void }>,
	Readonly<{ failed: boolean }>
> {
	override state = { failed: false };

	static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
		return { failed: true };
	}

	override componentDidCatch(error: Error): void {
		this.props.onError(error);
	}

	override render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}

const CUSTOM_UI_KEYBINDINGS = Object.freeze({
	composer: Object.freeze(
		CHAT_TEXT_AREA_KEY_BINDINGS.map((binding) => Object.freeze({ ...binding }))
	),
	dismiss: "escape",
	reclaim: "ctrl+c",
} as const);

type PluginUICustomEditorProps = Readonly<{
	children: ReactNode;
	pluginRuntime?: PluginRuntime;
	sessionId: string;
}>;

const customUIContext = (
	request: PluginUICustomHostRequest,
	sessionId: string,
	width: number,
	height: number,
	theme: Theme
): PluginUICustomContext<unknown> =>
	Object.freeze({
		done: request.done,
		environment: Object.freeze({
			executionMode: "interactive",
			sessionId,
		}),
		height,
		keybindings: CUSTOM_UI_KEYBINDINGS,
		signal: request.signal,
		theme,
		width,
	});

/** Replaces one Session's composer region without owning its renderer or transcript. */
export function PluginUICustomEditor({
	children,
	pluginRuntime: providedPluginRuntime,
	sessionId,
}: PluginUICustomEditorProps) {
	const host = useOptionalPluginUIHost();
	const pluginRuntime = providedPluginRuntime ?? getInteractivePluginRuntime();
	const request = useSyncExternalStore(
		host?.subscribeCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.subscribe,
		host?.getCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.get,
		host?.getCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.get
	);
	const activeRequest = request?.sessionId === sessionId ? request : null;
	const { pop, push } = useKeyboardLayer();
	const renderer = useRenderer();
	const { currentTheme } = useTheme();
	const dimensions = useTerminalDimensions();
	const factoryContextRef = useRef<PluginUICustomContext<unknown> | null>(null);
	factoryContextRef.current =
		activeRequest === null
			? null
			: customUIContext(
					activeRequest,
					sessionId,
					dimensions.width,
					dimensions.height,
					currentTheme
				);
	const [loadedComponent, setLoadedComponent] = useState<Readonly<{
		component: PluginUICustomComponent<unknown>;
		requestId: string;
	}> | null>(null);
	const layerId =
		activeRequest === null ? undefined : `plugin-custom-${activeRequest.id}`;

	useEffect(() => {
		if (host === null || pluginRuntime === undefined) {
			return;
		}
		return pluginRuntime.bindPluginUIHost(sessionId, host);
	}, [host, pluginRuntime, sessionId]);

	useLayoutEffect(() => {
		if (activeRequest === null || layerId === undefined) {
			return;
		}
		push(
			layerId,
			() => {
				activeRequest.dismiss();
				return true;
			},
			() => {
				activeRequest.dismiss();
				return true;
			}
		);
		return () => {
			if (!renderer.isDestroyed) {
				pop(layerId);
			}
		};
	}, [activeRequest, layerId, pop, push, renderer]);

	useEffect(() => {
		if (host === null || activeRequest === null) {
			setLoadedComponent(null);
			return;
		}
		let mounted = true;
		const context = factoryContextRef.current;
		if (context === null) {
			return;
		}
		const isCurrentRequest = () =>
			mounted &&
			!activeRequest.signal.aborted &&
			host.getCustomUI()?.id === activeRequest.id;
		setLoadedComponent((loaded) =>
			loaded?.requestId === activeRequest.id ? loaded : null
		);
		void Promise.resolve()
			.then(() => activeRequest.factory(context))
			.then((component) => {
				if (!isCurrentRequest()) {
					return;
				}
				if (typeof component !== "function") {
					throw new TypeError(
						"Plugin custom UI factory must return a React component."
					);
				}
				setLoadedComponent({ component, requestId: activeRequest.id });
			})
			.catch((error: unknown) => {
				if (isCurrentRequest()) {
					activeRequest.fail(error);
				}
			});
		return () => {
			mounted = false;
		};
	}, [activeRequest, host]);

	if (host === null) {
		return children;
	}

	const customContent =
		activeRequest === null
			? null
			: {
					component:
						loadedComponent?.requestId === activeRequest.id
							? loadedComponent.component
							: null,
					context: customUIContext(
						activeRequest,
						sessionId,
						dimensions.width,
						dimensions.height,
						currentTheme
					),
				};
	return (
		<>
			<box flexShrink={0} visible={activeRequest === null} width="100%">
				{children}
			</box>
			{activeRequest === null ? null : (
				<box flexDirection="column" flexShrink={0} width="100%">
					{customContent === null || customContent.component === null ? (
						<text fg={currentTheme.colors.textMuted}>
							Loading custom Plugin UI…
						</text>
					) : (
						<PluginUICustomErrorBoundary
							key={activeRequest.id}
							onError={activeRequest.fail}
						>
							{createElement(customContent.component, customContent.context)}
						</PluginUICustomErrorBoundary>
					)}
					<text fg={currentTheme.colors.textMuted} wrapMode="word">
						Escape dismiss · Ctrl+C reclaim editor
					</text>
				</box>
			)}
		</>
	);
}

const unsupportedThemeChange = (error: string): PluginThemeChangeResult => ({
	error,
	success: false,
});

const getPluginUIDialogTimeoutError = (
	options: PluginUIDialogOptions | undefined
): RangeError | undefined => {
	const timeout = options?.timeout;
	return timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)
		? new RangeError("Plugin UI timeout must be a finite non-negative number.")
		: undefined;
};

const isValidTheme = (candidate: unknown): candidate is Theme => {
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		Array.isArray(candidate)
	) {
		return false;
	}
	const value = candidate as Record<string, unknown>;
	const colors = value.colors;
	if (
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		colors === null ||
		typeof colors !== "object" ||
		Array.isArray(colors)
	) {
		return false;
	}
	const expectedColors = THEMES[0]?.colors;
	if (expectedColors === undefined) {
		return false;
	}
	const candidateColors = colors as Record<string, unknown>;
	return Object.entries(expectedColors).every(([key]) => {
		const value = candidateColors[key];
		if (key === "agent") {
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.values(value).every((color) => typeof color === "string")
			);
		}
		return typeof value === "string";
	});
};

const createPluginUIHost = ({
	customUI,
	dialog: getDialog,
	keyboardLayer: getKeyboardLayer,
	theme: getThemeContext,
	toast: getToast,
}: PluginUIHostDependencies): PluginUIHost => {
	let activeCustomRequest: (() => void) | undefined;
	let hostClosed = false;
	const shortcutSubscriptions = new Set<() => void>();
	const terminalInputSubscriptions = new Set<() => void>();
	return Object.freeze({
		close() {
			if (hostClosed) {
				return;
			}
			hostClosed = true;
			activeCustomRequest?.();
			for (const unsubscribe of [...shortcutSubscriptions]) {
				unsubscribe();
			}
			for (const unsubscribe of [...terminalInputSubscriptions]) {
				unsubscribe();
			}
		},
		registerShortcut(owner, shortcut, handler) {
			if (hostClosed) {
				return () => undefined;
			}
			const remove = getKeyboardLayer().registerShortcut(
				keyboardOwnerId(owner),
				shortcut,
				handler
			);
			let active = true;
			const unsubscribe = (): void => {
				if (!active) {
					return;
				}
				active = false;
				shortcutSubscriptions.delete(unsubscribe);
				remove();
			};
			shortcutSubscriptions.add(unsubscribe);
			return unsubscribe;
		},
		getCustomUI: customUI.get,
		subscribeCustomUI: customUI.subscribe,
		create(owner, beginPrompt, invocation) {
			const activeRequests = new Set<() => void>();
			const ownerInputSubscriptions = new Set<() => void>();
			let closed = false;

			const request = <Value,>(
				kind: PluginUIPromptKind,
				promptTitle: string,
				dialogTitle: string,
				defaultValue: Value,
				options: PluginUIDialogOptions | undefined,
				createContent: (resolve: (value: Value) => void) => ReactNode
			): Promise<Value> => {
				const signal = options?.signal;
				if (closed || signal?.aborted) {
					return Promise.resolve(defaultValue);
				}
				const timeoutError = getPluginUIDialogTimeoutError(options);
				if (timeoutError !== undefined) {
					return Promise.reject(timeoutError);
				}
				const timeout = options?.timeout;
				if (timeout === 0) {
					return Promise.resolve(defaultValue);
				}

				const result = Promise.withResolvers<Value>();
				const dialog = getDialog();
				const layerId = `plugin-ui-${owner.pluginId}-${crypto.randomUUID()}`;
				let endPrompt = (): void => undefined;
				let settled = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const finish = (value: Value, closeDialog = true): void => {
					if (settled) {
						return;
					}
					settled = true;
					if (timeoutHandle !== undefined) {
						clearTimeout(timeoutHandle);
					}
					signal?.removeEventListener("abort", onAbort);
					activeRequests.delete(cancel);
					endPrompt();
					if (closeDialog) {
						dialog.close(layerId);
					}
					result.resolve(value);
				};
				const cancel = (): void => finish(defaultValue);
				const onAbort = (): void => cancel();
				const onDismiss = (): void => finish(defaultValue, false);
				activeRequests.add(cancel);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) {
					cancel();
					return result.promise;
				}
				endPrompt = beginPrompt(kind, promptTitle);
				try {
					dialog.open({
						children: createElement(
							PluginDialogRequest,
							{ onDismiss },
							createContent((value) => finish(value))
						),
						layerId,
						title: dialogTitle,
					});
				} catch (error) {
					finish(defaultValue, false);
					return Promise.reject(error);
				}
				if (timeout !== undefined && !settled) {
					timeoutHandle = setTimeout(cancel, timeout);
				}
				return result.promise;
			};

			const requestCustom = <Value,>(
				factory: PluginUICustomFactory<Value>,
				options: PluginUICustomOptions | undefined
			): Promise<Value | undefined> => {
				if (closed || hostClosed || owner.sessionId === undefined) {
					return Promise.resolve(undefined);
				}
				if (activeCustomRequest !== undefined) {
					return Promise.reject(
						new PluginUICustomError("plugin_ui_custom_busy")
					);
				}

				const result = Promise.withResolvers<Value | undefined>();
				const controller = new AbortController();
				const requestId = `plugin-custom-${crypto.randomUUID()}`;
				const invitationLayerId = `${requestId}-invitation`;
				const title = options?.title ?? "Custom Plugin UI";
				let accepted = invocation === "command";
				let settled = false;
				let invitationOpen = false;
				let invitationDialog: DialogContextValue | undefined;
				let endPrompt = (): void => undefined;
				let presentation: PluginUICustomHostRequest | undefined;
				let cancel = (): void => undefined;
				const releaseAdmission = (): void => {
					if (activeCustomRequest === cancel) {
						activeCustomRequest = undefined;
					}
				};
				const closeInvitation = (): void => {
					if (!invitationOpen) {
						return;
					}
					invitationOpen = false;
					invitationDialog?.close(invitationLayerId);
				};
				const clearPresentation = (): void => {
					if (customUI.get()?.id !== requestId) {
						return;
					}
					if (hostClosed) {
						customUI.clear(requestId);
					} else {
						customUI.set(null);
					}
				};
				const endPromptSafely = (): void => {
					try {
						endPrompt();
					} catch {
						// Prompt observers cannot prevent custom UI cleanup.
					}
				};
				const finish = (
					value: Value | undefined,
					error?: PluginUICustomError,
					closePendingInvitation = true
				): void => {
					if (settled) {
						return;
					}
					settled = true;
					activeRequests.delete(cancel);
					releaseAdmission();
					if (closePendingInvitation) {
						closeInvitation();
					}
					controller.abort();
					clearPresentation();
					endPromptSafely();
					if (error === undefined) {
						result.resolve(value);
					} else {
						result.reject(error);
					}
				};
				cancel = () => finish(undefined);
				const fail = (error: unknown): void => {
					void logger
						.error("Plugin custom UI execution failed", {
							cause: error instanceof Error ? error.message : String(error),
							operation: "plugin.ui.custom",
							pluginId: owner.pluginId,
						})
						.catch(() => undefined);
					finish(
						undefined,
						new PluginUICustomError("plugin_ui_custom_failed", error)
					);
				};
				const hostFactory = (context: PluginUICustomContext<unknown>) =>
					factory(context as PluginUICustomContext<Value>) as unknown as
						| PluginUICustomComponent<unknown>
						| Promise<PluginUICustomComponent<unknown>>;
				const done = (value: unknown): void => finish(value as Value);
				presentation = Object.freeze({
					dismiss: cancel,
					done,
					factory: hostFactory,
					fail,
					id: requestId,
					sessionId: owner.sessionId,
					signal: controller.signal,
					title,
				});
				activeCustomRequest = cancel;
				activeRequests.add(cancel);
				try {
					endPrompt = beginPrompt("custom", title);
				} catch (error) {
					fail(error);
					return result.promise;
				}

				if (invocation === "command") {
					customUI.set(presentation);
				} else {
					invitationDialog = getDialog();
					invitationOpen = true;
					const dismissInvitation = (): void => {
						invitationOpen = false;
						if (!accepted) {
							finish(undefined, undefined, false);
						}
					};
					const accept = (): void => {
						if (settled || accepted || presentation === undefined) {
							return;
						}
						accepted = true;
						invitationOpen = false;
						invitationDialog?.close(invitationLayerId);
						customUI.set(presentation);
					};
					try {
						invitationDialog.open({
							children: createElement(
								PluginDialogRequest,
								{ onDismiss: dismissInvitation },
								createElement(PluginUICustomInvitation, {
									onAccept: accept,
									onDecline: cancel,
									pluginId: owner.pluginId,
									title,
								})
							),
							layerId: invitationLayerId,
							title: "Plugin UI invitation",
						});
					} catch (error) {
						fail(error);
					}
				}
				return result.promise;
			};

			const ui: PluginUI = Object.freeze({
				select: (prompt, choices, options) => {
					if (choices.length === 0) {
						return Promise.resolve(undefined);
					}
					return request<string | undefined>(
						"select",
						prompt,
						"Plugin Selection",
						undefined,
						options,
						(resolve) =>
							createElement(PluginSelectDialog, {
								choices,
								onResolve: resolve,
								prompt,
							})
					);
				},
				confirm: (title, message, options) =>
					request("confirm", title, title, false, options, (resolve) =>
						createElement(PluginConfirmDialog, {
							message,
							onResolve: resolve,
						})
					),
				input: (title, placeholder, options) =>
					request<string | undefined>(
						"input",
						title,
						title,
						undefined,
						options,
						(resolve) =>
							createElement(PluginInputDialog, {
								onResolve: resolve,
								...(isUndefined(placeholder) ? {} : { placeholder }),
							})
					),
				editor: (title, initialValue, options) =>
					request<string | undefined>(
						"editor",
						title,
						title,
						undefined,
						options,
						(resolve) =>
							createElement(PluginEditorDialog, {
								initialValue: initialValue ?? "",
								onResolve: resolve,
							})
					),
				custom: (factory, options) => requestCustom(factory, options),
				onTerminalInput: (handler) => {
					if (closed || hostClosed) {
						return () => undefined;
					}
					const remove = getKeyboardLayer().registerTerminalInput(
						keyboardOwnerId(owner),
						(data) => handler(data)?.consume === true
					);
					let active = true;
					const unsubscribe = (): void => {
						if (!active) {
							return;
						}
						active = false;
						ownerInputSubscriptions.delete(unsubscribe);
						terminalInputSubscriptions.delete(unsubscribe);
						remove();
					};
					ownerInputSubscriptions.add(unsubscribe);
					terminalInputSubscriptions.add(unsubscribe);
					return unsubscribe;
				},
				notify: (message, level: PluginNotificationLevel = "info") => {
					if (closed) {
						return;
					}
					getToast().show({ message, variant: level });
				},
				getAllThemes: () => structuredClone(THEMES),
				getTheme: (name) => {
					const theme = findThemeByName(THEMES, name);
					return theme === undefined ? undefined : structuredClone(theme);
				},
				setTheme: (theme) => {
					if (closed) {
						return unsupportedThemeChange(
							"Plugin UI host is no longer active."
						);
					}
					try {
						let nextTheme: Theme;
						if (typeof theme === "string") {
							const bundledTheme = findThemeByName(THEMES, theme);
							if (bundledTheme === undefined) {
								return unsupportedThemeChange(`Unknown theme '${theme}'.`);
							}
							nextTheme = bundledTheme;
						} else {
							if (!isValidTheme(theme)) {
								return unsupportedThemeChange("Theme object is invalid.");
							}
							nextTheme = structuredClone(theme);
						}
						getThemeContext().setTheme(nextTheme);
						return { success: true };
					} catch (error) {
						return unsupportedThemeChange(
							error instanceof Error ? error.message : String(error)
						);
					}
				},
			});

			return Object.freeze({
				close() {
					if (closed) {
						return;
					}
					closed = true;
					for (const cancel of [...activeRequests]) {
						cancel();
					}
					for (const unsubscribe of [...ownerInputSubscriptions]) {
						unsubscribe();
					}
				},
				ui,
			});
		},
	});
};

const PluginUIHostContext = createContext<PluginUIHost | null>(null);

export function PluginUIHostProvider({
	children,
}: Readonly<{ children: ReactNode }>) {
	const dialog = useDialog();
	const keyboardLayer = useKeyboardLayer();
	const theme = useTheme();
	const toast = useToast();
	const customUI = useMemo(createPluginUICustomStore, []);
	const dialogRef = useRef(dialog);
	const keyboardLayerRef = useRef(keyboardLayer);
	const themeRef = useRef(theme);
	const toastRef = useRef(toast);
	dialogRef.current = dialog;
	keyboardLayerRef.current = keyboardLayer;
	themeRef.current = theme;
	toastRef.current = toast;
	const host = useMemo(
		() =>
			createPluginUIHost({
				customUI,
				dialog: () => dialogRef.current,
				keyboardLayer: () => keyboardLayerRef.current,
				theme: () => themeRef.current,
				toast: () => toastRef.current,
			}),
		[customUI]
	);
	useEffect(() => () => host.close(), [host]);
	return (
		<PluginUIHostContext.Provider value={host}>
			{children}
		</PluginUIHostContext.Provider>
	);
}

export function useOptionalPluginUIHost(): PluginUIHost | null {
	return useContext(PluginUIHostContext);
}

export function usePluginUIHost(): PluginUIHost {
	const host = useOptionalPluginUIHost();
	if (host === null) {
		throw new Error("usePluginUIHost must be used within PluginUIHostProvider");
	}
	return host;
}

export type { PluginUIHandle, PluginUIOwner };
