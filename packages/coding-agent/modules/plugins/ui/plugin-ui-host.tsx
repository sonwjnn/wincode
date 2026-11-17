import type {
	InputRenderable,
	SelectRenderable,
	TextareaRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { isUndefined } from "@wincode/utils";
import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import type { DialogContextValue } from "../../../shared/providers/dialog/dialog-provider";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "../../../shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "../../../shared/providers/keyboard-layer/keyboard-layer-provider";
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
	PluginUIDialogOptions,
	PluginUIPromptKind,
} from "../public";

type PluginUIOwner = Readonly<{
	pluginId: string;
	sessionId?: string;
}>;

type PluginUIHandle = Readonly<{
	close: () => void;
	ui: PluginUI;
}>;

export type PluginUIHost = Readonly<{
	create: (
		owner: PluginUIOwner,
		beginPrompt: (kind: PluginUIPromptKind, title: string) => () => void
	) => PluginUIHandle;
}>;

type PluginUIHostDependencies = Readonly<{
	dialog: () => DialogContextValue;
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
	dialog: getDialog,
	theme: getThemeContext,
	toast: getToast,
}: PluginUIHostDependencies): PluginUIHost =>
	Object.freeze({
		create(owner, beginPrompt) {
			const activeRequests = new Set<() => void>();
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
				},
				ui,
			});
		},
	});

const PluginUIHostContext = createContext<PluginUIHost | null>(null);

export function PluginUIHostProvider({
	children,
}: Readonly<{ children: ReactNode }>) {
	const dialog = useDialog();
	const theme = useTheme();
	const toast = useToast();
	const dialogRef = useRef(dialog);
	const themeRef = useRef(theme);
	const toastRef = useRef(toast);
	dialogRef.current = dialog;
	themeRef.current = theme;
	toastRef.current = toast;
	const host = useMemo(
		() =>
			createPluginUIHost({
				dialog: () => dialogRef.current,
				theme: () => themeRef.current,
				toast: () => toastRef.current,
			}),
		[]
	);
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
