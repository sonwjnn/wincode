import {
	ConfirmDialog,
	createPortal,
	InputDialog,
	MultilineEditor,
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@wincode/tui";
import type {
	BoxRenderable,
	SelectRenderable,
	TextareaRenderable,
} from "@wincode/tui/core";
import { RGBA } from "@wincode/tui/core";
import { isUndefined, logger, omitUndefined } from "@wincode/utils";
import {
	Component,
	createContext,
	createElement,
	type ReactNode,
	useCallback,
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
	PluginAutocompleteContext,
	PluginAutocompleteProviderFactory,
	PluginAutocompleteProviderOptions,
	PluginEditorComponent,
	PluginEditorContext,
	PluginNotificationLevel,
	PluginThemeChangeResult,
	PluginUI,
	PluginUIChromeContext,
	PluginUIContributionResult,
	PluginUICustomBounds,
	PluginUICustomComponent,
	PluginUICustomContext,
	PluginUICustomFactory,
	PluginUICustomOptions,
	PluginUICustomPresentationHandle,
	PluginUICustomPresentationMode,
	PluginUIDialogOptions,
	PluginUIFooterComponent,
	PluginUIFooterContext,
	PluginUIHeaderComponent,
	PluginUIPromptKind,
	PluginUIUpdate,
	PluginUIWidgetComponent,
	PluginUIWidgetPlacement,
} from "../public";
import { PluginUICustomError } from "../public";
import type { PluginRuntime } from "../runtime";
import {
	createPluginUIContributionStore,
	createPluginUIUpdateControls,
	EMPTY_PLUGIN_UI_CHROME,
	EMPTY_PLUGIN_UI_VIEW,
	type PluginUIChromeSnapshot,
	type PluginUIContributionStore,
	type PluginUITitleSnapshot,
	type PluginUIUpdateSink,
	type PluginUIViewContributions,
} from "./plugin-ui-contributions";
import type {
	PluginUIHostBinding,
	PluginUIOwner as PluginUIOwnerType,
} from "./plugin-ui-host-contract";
import {
	schedulePluginUITimeout,
	schedulePluginUITitleCountdown,
} from "./plugin-ui-timeout";

export type { PluginUIHandle, PluginUIOwner } from "./plugin-ui-host-contract";

type PluginUIKeyboardLayer = Pick<
	KeyboardLayerContextValue,
	"registerShortcut" | "registerTerminalInput"
>;

const keyboardOwnerId = (owner: PluginUIOwnerType): string =>
	`${owner.sessionId ?? "process"}:${owner.pluginId}`;

type PluginUICustomPresentationState = Readonly<{
	getRevision: () => number;
	handle: PluginUICustomPresentationHandle;
	setBounds: (bounds: PluginUICustomBounds) => void;
	subscribe: (listener: () => void) => () => void;
}>;

type PluginEditorContribution = Readonly<{
	component: PluginEditorComponent;
	pluginId: string;
}>;

type PluginAutocompleteRegistration = Readonly<{
	owner: PluginUIOwnerType;
	provider: PluginAutocompleteProviderFactory;
}>;

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
	presentation: PluginUICustomPresentationMode;
	options: PluginUICustomOptions;
	presentationHandle: PluginUICustomPresentationState;
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

const presentPluginUICustomRequest = (
	request: PluginUICustomHostRequest,
	pluginId: string,
	invocation: "command" | "event",
	customUI: PluginUICustomStore,
	getDialog: () => DialogContextValue,
	onAccept: () => void,
	onDismiss: () => void,
	onDecline: () => void,
	onFailure: (error: unknown) => void
): DialogContextValue | undefined => {
	if (invocation === "command") {
		customUI.set(request);
		return;
	}
	const dialog = getDialog();
	try {
		dialog.open({
			children: createElement(
				PluginDialogRequest,
				{ onDismiss },
				createElement(PluginUICustomInvitation, {
					onAccept,
					onDecline,
					pluginId,
					title: request.title,
				})
			),
			layerId: `${request.id}-invitation`,
			title: "Plugin UI invitation",
		});
	} catch (error) {
		onFailure(error);
	}
	return dialog;
};

const createPluginUICustomPresentationState =
	(): PluginUICustomPresentationState => {
		let revision = 0;
		let focused = true;
		let hidden = false;
		let bounds: PluginUICustomBounds = Object.freeze({
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		});
		const listeners = new Set<() => void>();
		const notify = (): void => {
			revision += 1;
			for (const listener of [...listeners]) {
				listener();
			}
		};
		const handle: PluginUICustomPresentationHandle = Object.freeze({
			focus() {
				if (focused) {
					return;
				}
				focused = true;
				notify();
			},
			unfocus() {
				if (!focused) {
					return;
				}
				focused = false;
				notify();
			},
			setHidden(nextHidden) {
				if (hidden === nextHidden) {
					return;
				}
				hidden = nextHidden;
				notify();
			},
			isHidden: () => hidden,
			isFocused: () => focused,
			getBounds: () => bounds,
		});
		return Object.freeze({
			getRevision: () => revision,
			handle,
			setBounds(nextBounds) {
				if (
					bounds.left === nextBounds.left &&
					bounds.top === nextBounds.top &&
					bounds.width === nextBounds.width &&
					bounds.height === nextBounds.height
				) {
					return;
				}
				bounds = Object.freeze({ ...nextBounds });
				notify();
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
	};

export type PluginComposerHost = Readonly<{
	getText: () => string;
	pasteText: (text: string) => boolean;
	setText: (text: string, cursorOffset?: number) => boolean;
}>;

const EMPTY_PLUGIN_CUSTOM_UI = createPluginUICustomStore();
const subscribeToNoCustomUI = (_listener: () => void) => () => undefined;
const getNoCustomUIRevision = () => 0;

export type PluginUIHost = PluginUIHostBinding &
	Readonly<{
		registerShortcut: (
			owner: PluginUIOwnerType,
			shortcut: string,
			handler: () => void
		) => () => void;
		clearPlugin: (pluginId: string) => void;
		getChrome: () => PluginUIChromeSnapshot;
		getContributions: (sessionId: string) => PluginUIViewContributions;
		getTitle: () => PluginUITitleSnapshot;
		setToolsExpanded: (sessionId: string, expanded: boolean) => void;
		bindComposer: (
			sessionId: string,
			composer: PluginComposerHost
		) => () => void;
		getComposer: (sessionId: string) => PluginComposerHost | undefined;
		getActiveEditorComponent: (
			sessionId: string
		) => PluginEditorComponent | undefined;
		subscribeEditor: (sessionId: string, listener: () => void) => () => void;
		getAutocompleteProviders: (
			sessionId: string
		) => readonly PluginAutocompleteProviderFactory[];
		subscribeAutocompleteProviders: (
			sessionId: string,
			listener: () => void
		) => () => void;
		getCustomUI: () => PluginUICustomHostRequest | null;
		subscribeChrome: (listener: () => void) => () => void;
		subscribeTitle: (listener: () => void) => () => void;
		subscribeContributions: (
			sessionId: string,
			listener: () => void
		) => () => void;
		subscribeCustomUI: (listener: () => void) => () => void;
	}>;

type PluginUIHostDependencies = Readonly<{
	contributions: PluginUIContributionStore;
	customUI: PluginUICustomStore;
	onUpdate?: PluginUIUpdateSink;
	dialog: () => DialogContextValue;
	keyboardLayer: () => PluginUIKeyboardLayer;
	theme: () => Readonly<{ setTheme: (theme: Theme) => void }>;
	toast: () => ToastContextValue;
}>;

const isEscapeHandledByDialogContent = (kind: PluginUIPromptKind): boolean =>
	kind === "confirm" || kind === "input";

type PluginDialogRequestProps = Readonly<{
	children?: ReactNode;
	escapeHandledByContent?: boolean;
	onDismiss: () => void;
}>;

const PluginDialogRequest = ({
	children,
	escapeHandledByContent = false,
	onDismiss,
}: PluginDialogRequestProps) => {
	useDialogEscape(undefined, !escapeHandledByContent);
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
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	return (
		<DialogInset>
			<ConfirmDialog
				active={isTopLayer(layerId)}
				message={message}
				onCancel={() => onResolve(false)}
				onConfirm={onResolve}
			/>
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
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	return (
		<DialogInset>
			<InputDialog
				active={isTopLayer(layerId)}
				onCancel={() => onResolve(undefined)}
				onSubmit={onResolve}
				placeholder={placeholder}
			/>
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
				<MultilineEditor
					focused
					focusedTextColor={colors.text}
					height={10}
					initialValue={initialValue}
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

type PluginUIChromeErrorBoundaryProps = Readonly<{
	children: ReactNode;
	component:
		| PluginUIFooterComponent
		| PluginUIHeaderComponent
		| PluginUIWidgetComponent;
	fallback: ReactNode;
	pluginId: string;
	surface: "header" | "footer" | "widget";
}>;

class PluginUIChromeErrorBoundary extends Component<
	PluginUIChromeErrorBoundaryProps,
	Readonly<{ failed: boolean }>
> {
	override state = { failed: false };

	static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
		return { failed: true };
	}

	override componentDidCatch(error: Error): void {
		void logger
			.error("Plugin UI contribution failed to render", {
				cause: error.message,
				operation: `plugin.ui.${this.props.surface}`,
				pluginId: this.props.pluginId,
			})
			.catch(() => undefined);
	}

	override componentDidUpdate(
		previousProps: PluginUIChromeErrorBoundaryProps
	): void {
		if (this.state.failed && previousProps.component !== this.props.component) {
			this.setState({ failed: false });
		}
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

const CUSTOM_UI_KEYBINDINGS = Object.freeze({
	composer: Object.freeze(
		CHAT_TEXT_AREA_KEY_BINDINGS.map((binding) => Object.freeze({ ...binding }))
	),
	dismiss: "escape",
	reclaim: "ctrl+c",
} as const);

type PluginUICustomPresentationProps = Readonly<{
	children: ReactNode;
	pluginRuntime?: PluginRuntime;
	sessionId: string;
}>;

type PluginUICustomPresentationLayerProps = Readonly<{
	bounds: PluginUICustomBounds;
	component: PluginUICustomComponent<unknown> | null;
	context: PluginUICustomContext<unknown>;
	height: number;
	isHidden: boolean;
	request: PluginUICustomHostRequest;
	theme: Theme;
	width: number;
}>;

const CUSTOM_UI_OVERLAY_MAX_WIDTH = 80;
const CUSTOM_UI_OVERLAY_MAX_HEIGHT = 24;
const CUSTOM_UI_OVERLAY_MARGIN = 2;
const AUTOCOMPLETE_INVALID_TRIGGER_PATTERN = /[\s\p{C}]/u;
const AUTOCOMPLETE_WHITESPACE_PATTERN = /\s/;
const PLUGIN_UI_OVERLAY_PERCENT_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)%$/;

const normalizeAutocompleteTriggerCharacters = (
	options: PluginAutocompleteProviderOptions | undefined
): readonly string[] | undefined => {
	const characters = options?.triggerCharacters;
	if (characters === undefined) {
		return;
	}
	if (!Array.isArray(characters) || characters.length === 0) {
		throw new TypeError("triggerCharacters must be a nonempty character list.");
	}
	const normalized = new Set<string>();
	for (const character of characters) {
		if (
			typeof character !== "string" ||
			[...character].length !== 1 ||
			AUTOCOMPLETE_INVALID_TRIGGER_PATTERN.test(character) ||
			character === "/" ||
			character === "@"
		) {
			throw new TypeError(
				"Each autocomplete trigger must be one printable non-whitespace character other than / or @."
			);
		}
		normalized.add(character);
	}
	return Object.freeze([...normalized]);
};

const matchesAutocompleteTrigger = (
	context: PluginAutocompleteContext,
	triggerCharacters: readonly string[]
): boolean => {
	const beforeCursor = context.text.slice(0, context.cursorOffset);
	let tokenStart = beforeCursor.length;
	while (
		tokenStart > 0 &&
		!AUTOCOMPLETE_WHITESPACE_PATTERN.test(beforeCursor[tokenStart - 1] ?? "")
	) {
		tokenStart -= 1;
	}
	const token = beforeCursor.slice(tokenStart);
	return triggerCharacters.some((character) => token.startsWith(character));
};

const createTriggeredAutocompleteProvider =
	(
		factory: PluginAutocompleteProviderFactory,
		triggerCharacters: readonly string[]
	): PluginAutocompleteProviderFactory =>
	(current) => {
		const provider = factory(current);
		const shouldTrigger = (context: PluginAutocompleteContext): boolean =>
			matchesAutocompleteTrigger(context, triggerCharacters);
		return {
			...provider,
			getSuggestions(context) {
				return shouldTrigger(context)
					? provider.getSuggestions(context)
					: current.getSuggestions(context);
			},
			applyCompletion(context, item, prefix) {
				return shouldTrigger(context)
					? provider.applyCompletion(context, item, prefix)
					: current.applyCompletion(context, item, prefix);
			},
			shouldTriggerFileCompletion(context) {
				const activeProvider = shouldTrigger(context) ? provider : current;
				// The composer treats an absent hook as permission to complete files.
				return activeProvider.shouldTriggerFileCompletion?.(context) !== false;
			},
		};
	};

const getCustomUIFooterHint = (
	presentation: PluginUICustomHostRequest["presentation"]
): string =>
	presentation === "editor"
		? "Escape dismiss · Ctrl+C reclaim editor"
		: "Escape dismiss · Ctrl+C reclaim app";

const getPluginUICustomBounds = (
	presentation: PluginUICustomHostRequest["presentation"],
	width: number,
	height: number,
	options: PluginUICustomOptions
): PluginUICustomBounds => {
	if (presentation !== "overlay") {
		return { height, left: 0, top: 0, width };
	}
	const requestedMargin = options.margin ?? CUSTOM_UI_OVERLAY_MARGIN;
	const margin = Math.min(
		requestedMargin,
		Math.floor(Math.max(0, width - 1) / 2),
		Math.floor(Math.max(0, height - 1) / 2)
	);
	const availableWidth = Math.max(1, width - margin * 2);
	const availableHeight = Math.max(1, height - margin * 2);
	const requestedWidth =
		typeof options.width === "string"
			? Math.floor((availableWidth * Number.parseFloat(options.width)) / 100)
			: (options.width ?? CUSTOM_UI_OVERLAY_MAX_WIDTH);
	const boundedWidth = Math.min(availableWidth, Math.max(1, requestedWidth));
	const boundedHeight = Math.min(
		availableHeight,
		options.maxHeight ?? CUSTOM_UI_OVERLAY_MAX_HEIGHT
	);
	const anchor = options.anchor ?? "center";
	let left: number;
	if (anchor.endsWith("right")) {
		left = width - margin - boundedWidth;
	} else if (anchor.endsWith("left")) {
		left = margin;
	} else {
		left = Math.floor((width - boundedWidth) / 2);
	}
	let top: number;
	if (anchor.startsWith("top")) {
		top = margin;
	} else if (anchor.startsWith("bottom")) {
		top = height - margin - boundedHeight;
	} else {
		top = Math.floor((height - boundedHeight) / 2);
	}
	return { height: boundedHeight, left, top, width: boundedWidth };
};

const invalidPluginUICustomOptions = (reason: string): never => {
	throw new PluginUICustomError(
		"plugin_ui_custom_invalid_options",
		new TypeError(reason)
	);
};

const validatePluginUICustomWidth = (
	width: PluginUICustomOptions["width"]
): void => {
	if (width === undefined) {
		return;
	}
	if (typeof width === "number" && Number.isInteger(width) && width > 0) {
		return;
	}
	if (
		typeof width === "string" &&
		PLUGIN_UI_OVERLAY_PERCENT_PATTERN.test(width) &&
		Number.parseFloat(width) > 0 &&
		Number.parseFloat(width) <= 100
	) {
		return;
	}
	invalidPluginUICustomOptions(
		"width must be a positive whole number of cells or a percentage up to 100%."
	);
};

const validatePluginUICustomBehaviorOptions = (
	options: PluginUICustomOptions
): void => {
	if (
		options.resolvePlacement !== undefined &&
		typeof options.resolvePlacement !== "function"
	) {
		invalidPluginUICustomOptions("resolvePlacement must be a function.");
	}
};

const validatePluginUICustomOptions = (
	options: PluginUICustomOptions | undefined
): PluginUICustomOptions => {
	if (
		options !== undefined &&
		(typeof options !== "object" || options === null || Array.isArray(options))
	) {
		throw new PluginUICustomError(
			"plugin_ui_custom_invalid_options",
			new TypeError("options must be an object.")
		);
	}
	const value = options ?? {};
	const presentation = value.presentation;
	const overlayOptions = [
		value.anchor,
		value.width,
		value.maxHeight,
		value.margin,
		value.resolvePlacement,
	];

	if (
		presentation !== undefined &&
		!(["editor", "overlay", "full-screen"] as const).includes(presentation)
	) {
		invalidPluginUICustomOptions(
			"presentation must be editor, overlay, or full-screen."
		);
	}
	const presentationMode = presentation ?? "editor";
	if (
		presentationMode !== "overlay" &&
		overlayOptions.some((entry) => entry !== undefined)
	) {
		invalidPluginUICustomOptions(
			"Overlay placement options require presentation: overlay."
		);
	}
	if (
		value.anchor !== undefined &&
		!(
			[
				"center",
				"top-left",
				"top-right",
				"bottom-left",
				"bottom-right",
			] as const
		).includes(value.anchor)
	) {
		invalidPluginUICustomOptions("anchor must be center or a named corner.");
	}
	validatePluginUICustomBehaviorOptions(value);
	validatePluginUICustomWidth(value.width);
	if (
		value.maxHeight !== undefined &&
		(!Number.isInteger(value.maxHeight) || value.maxHeight <= 0)
	) {
		invalidPluginUICustomOptions(
			"maxHeight must be a positive whole number of cells."
		);
	}
	if (
		value.margin !== undefined &&
		(!Number.isInteger(value.margin) || value.margin < 0)
	) {
		invalidPluginUICustomOptions(
			"margin must be a nonnegative whole number of cells."
		);
	}
	return Object.freeze({ ...value, presentation: presentationMode });
};

const getAvailablePluginUISessionId = (
	closed: boolean,
	hostClosed: boolean,
	sessionId: string | undefined
): string | undefined => {
	if (closed || hostClosed) {
		return;
	}
	return sessionId;
};

const canAcceptPluginUICustomInvitation = (
	settled: boolean,
	accepted: boolean,
	presentation: PluginUICustomHostRequest | undefined
): boolean => !(settled || accepted) && presentation !== undefined;

const getValidatedPluginUICustomOptions = (
	options: PluginUICustomOptions | undefined
):
	| Readonly<{ options: PluginUICustomOptions }>
	| Readonly<{ error: unknown }> => {
	try {
		return { options: validatePluginUICustomOptions(options) };
	} catch (error) {
		return { error };
	}
};

type PluginUICustomBoundsResolution =
	| Readonly<{ ok: true; bounds: PluginUICustomBounds | null }>
	| Readonly<{ ok: false; error: unknown }>;

const getPluginUICustomRequestBounds = (
	request: PluginUICustomHostRequest | null,
	width: number,
	height: number
): PluginUICustomBoundsResolution => {
	if (request === null) {
		return { bounds: null, ok: true };
	}
	try {
		let options = request.options;
		if (request.options.resolvePlacement !== undefined) {
			const dimensions = Object.freeze({ width, height });
			const placement = request.options.resolvePlacement(dimensions);
			if (
				placement === null ||
				typeof placement !== "object" ||
				Array.isArray(placement)
			) {
				invalidPluginUICustomOptions(
					"resolvePlacement must return overlay placement options."
				);
			}
			options = validatePluginUICustomOptions({ ...options, ...placement });
		}
		return {
			bounds: getPluginUICustomBounds(
				request.presentation,
				width,
				height,
				options
			),
			ok: true,
		};
	} catch (error) {
		return { error, ok: false };
	}
};

const customUIContext = (
	request: PluginUICustomHostRequest,
	sessionId: string,
	bounds: PluginUICustomBounds,
	theme: Theme
): PluginUICustomContext<unknown> =>
	Object.freeze({
		done: request.done,
		environment: Object.freeze({
			executionMode: "interactive",
			sessionId,
		}),
		height: bounds.height,
		keybindings: CUSTOM_UI_KEYBINDINGS,
		presentation: request.presentation,
		presentationHandle: request.presentationHandle.handle,
		signal: request.signal,
		theme,
		width: bounds.width,
	});

type PluginUICustomRenderContent = Readonly<{
	bounds: PluginUICustomBounds;
	component: PluginUICustomComponent<unknown> | null;
	context: PluginUICustomContext<unknown>;
}>;

const getPluginUICustomRenderContent = (
	request: PluginUICustomHostRequest | null,
	bounds: PluginUICustomBounds | null,
	loadedComponent: Readonly<{
		component: PluginUICustomComponent<unknown>;
		requestId: string;
	}> | null,
	sessionId: string,
	theme: Theme
): PluginUICustomRenderContent | null => {
	if (request === null || bounds === null) {
		return null;
	}
	return {
		bounds,
		component:
			loadedComponent?.requestId === request.id
				? loadedComponent.component
				: null,
		context: customUIContext(request, sessionId, bounds, theme),
	};
};

const updateCustomUIPresentationBounds = (
	presentationHandle: PluginUICustomPresentationState,
	renderable: BoxRenderable | null
): void => {
	if (renderable === null) {
		return;
	}
	presentationHandle.setBounds({
		left: renderable.screenX,
		top: renderable.screenY,
		width: renderable.width,
		height: renderable.height,
	});
};

function PluginUICustomPresentationLayer({
	bounds,
	component,
	context,
	height,
	isHidden,
	request,
	theme,
	width,
}: PluginUICustomPresentationLayerProps) {
	useLayoutEffect(() => {
		request.presentationHandle.setBounds(bounds);
	}, [bounds, request.presentationHandle]);
	const content =
		component === null ? (
			<text fg={theme.colors.textMuted}>Loading custom Plugin UI…</text>
		) : (
			<PluginUICustomErrorBoundary key={request.id} onError={request.fail}>
				{createElement(component, context)}
			</PluginUICustomErrorBoundary>
		);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes receive terminal mouse events.
		<box
			height={height}
			left={0}
			onMouseDown={(event) => event.stopPropagation()}
			position="absolute"
			top={0}
			visible={!isHidden}
			width={width}
			zIndex={100}
		>
			{request.presentation === "overlay" ? (
				<box
					backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
					height={height}
					left={0}
					position="absolute"
					top={0}
					width={width}
				/>
			) : null}
			<box
				backgroundColor={
					request.presentation === "full-screen"
						? theme.colors.background
						: theme.colors.backgroundElement
				}
				height={bounds.height}
				left={bounds.left}
				overflow="hidden"
				position="absolute"
				top={bounds.top}
				width={bounds.width}
				zIndex={1}
			>
				<box flexDirection="column" height="100%" width="100%">
					{content}
					<text fg={theme.colors.textMuted} wrapMode="word">
						{getCustomUIFooterHint(request.presentation)}
					</text>
				</box>
			</box>
		</box>
	);
}

const getSessionCustomUIRequest = (
	request: PluginUICustomHostRequest | null,
	sessionId: string
): PluginUICustomHostRequest | null =>
	request?.sessionId === sessionId ? request : null;

/** Mounts host-mediated custom UI without taking ownership of the renderer. */
export function PluginUICustomPresentation({
	children,
	pluginRuntime: providedPluginRuntime,
	sessionId,
}: PluginUICustomPresentationProps) {
	const host = useOptionalPluginUIHost();
	const pluginRuntime = providedPluginRuntime ?? getInteractivePluginRuntime();
	const request = useSyncExternalStore(
		host?.subscribeCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.subscribe,
		host?.getCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.get,
		host?.getCustomUI ?? EMPTY_PLUGIN_CUSTOM_UI.get
	);
	const contributions = usePluginUIContributions(sessionId);
	const activeRequest = getSessionCustomUIRequest(request, sessionId);
	useSyncExternalStore(
		activeRequest?.presentationHandle.subscribe ?? subscribeToNoCustomUI,
		activeRequest?.presentationHandle.getRevision ?? getNoCustomUIRevision,
		activeRequest?.presentationHandle.getRevision ?? getNoCustomUIRevision
	);
	const isPresentationHidden =
		activeRequest?.presentationHandle.handle.isHidden() ?? false;
	const editorBoundsRef = useRef<BoxRenderable>(null);
	const activeRequestRef = useRef(activeRequest);
	activeRequestRef.current = activeRequest;
	const { isTopLayer, pop, push } = useKeyboardLayer();
	const renderer = useRenderer();
	const { currentTheme } = useTheme();
	const dimensions = useTerminalDimensions();
	const customBoundsResolution = useMemo(
		() =>
			getPluginUICustomRequestBounds(
				activeRequest,
				dimensions.width,
				dimensions.height
			),
		[activeRequest, dimensions.height, dimensions.width]
	);
	const customBounds = customBoundsResolution.ok
		? customBoundsResolution.bounds
		: null;
	const [loadedComponent, setLoadedComponent] = useState<Readonly<{
		component: PluginUICustomComponent<unknown>;
		requestId: string;
	}> | null>(null);
	const customContent = getPluginUICustomRenderContent(
		activeRequest,
		customBounds,
		loadedComponent,
		sessionId,
		currentTheme
	);
	const factoryContextRef = useRef<PluginUICustomContext<unknown> | null>(null);
	factoryContextRef.current = customContent?.context ?? null;
	const layerId =
		activeRequest === null ? undefined : `plugin-custom-${activeRequest.id}`;

	useLayoutEffect(() => {
		if (activeRequest !== null && !customBoundsResolution.ok) {
			activeRequest.fail(customBoundsResolution.error);
		}
	}, [activeRequest, customBoundsResolution]);

	useEffect(() => {
		if (host === null || pluginRuntime === undefined) {
			return;
		}
		return pluginRuntime.bindPluginUIHost(sessionId, host);
	}, [host, pluginRuntime, sessionId]);

	useLayoutEffect(() => {
		if (
			activeRequest === null ||
			layerId === undefined ||
			!customBoundsResolution.ok
		) {
			return;
		}
		const dismiss = (): true => {
			activeRequest.dismiss();
			return true;
		};
		push(layerId, dismiss, dismiss);
		return () => {
			if (!renderer.isDestroyed) {
				pop(layerId);
			}
		};
	}, [activeRequest, layerId, pop, push, customBoundsResolution, renderer]);

	useKeyboard((key) => {
		const current = activeRequestRef.current;
		if (
			current === null ||
			!isTopLayer(`plugin-custom-${current.id}`) ||
			key.name !== "escape"
		) {
			return;
		}
		key.preventDefault();
		current.dismiss();
	});

	useLayoutEffect(() => {
		if (activeRequest?.presentation !== "editor") {
			return;
		}
		updateCustomUIPresentationBounds(
			activeRequest.presentationHandle,
			editorBoundsRef.current
		);
	}, [activeRequest]);
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

	const renderWidgets = (placement: PluginUIWidgetPlacement) => {
		const widgets = contributions.widgets.filter(
			(widget) => widget.placement === placement
		);
		if (widgets.length === 0) {
			return null;
		}
		const componentCount = widgets.filter(
			(widget) => "component" in widget
		).length;
		const maxWidgetHeight =
			componentCount === 0
				? 0
				: Math.max(
						0,
						Math.floor((dimensions.height - 4) / (3 * componentCount))
					);
		return (
			<box flexDirection="column" flexShrink={0} width="100%">
				{widgets.map((widget) => {
					let widgetContent: ReactNode;
					if (widget.lines !== undefined) {
						widgetContent = (
							<text fg={currentTheme.colors.textMuted} wrapMode="word">
								{widget.lines.join("\n")}
							</text>
						);
					} else if (maxWidgetHeight === 0) {
						widgetContent = null;
					} else {
						widgetContent = (
							<box height={maxWidgetHeight} overflow="hidden" width="100%">
								<PluginUIChromeErrorBoundary
									component={widget.component}
									fallback={null}
									key={`${widget.pluginId}:${widget.key}:component`}
									pluginId={widget.pluginId}
									surface="widget"
								>
									{createElement(widget.component, {
										height: maxWidgetHeight,
										theme: currentTheme,
										width: Math.max(0, dimensions.width - 2),
									})}
								</PluginUIChromeErrorBoundary>
							</box>
						);
					}
					return (
						<box
							flexDirection="column"
							key={`${widget.pluginId}:${widget.key}`}
							paddingX={1}
							width="100%"
						>
							{widgetContent}
						</box>
					);
				})}
			</box>
		);
	};
	if (activeRequest?.presentation === "editor") {
		return (
			<>
				{renderWidgets("aboveEditor")}
				<box flexShrink={0} visible={isPresentationHidden} width="100%">
					{children}
				</box>
				<box
					flexDirection="column"
					flexShrink={0}
					onSizeChange={() =>
						updateCustomUIPresentationBounds(
							activeRequest.presentationHandle,
							editorBoundsRef.current
						)
					}
					ref={editorBoundsRef}
					visible={!isPresentationHidden}
					width="100%"
				>
					{customContent?.component === null || customContent === null ? (
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
						{getCustomUIFooterHint(activeRequest.presentation)}
					</text>
				</box>
				{renderWidgets("belowEditor")}
			</>
		);
	}

	const portal =
		activeRequest === null || customContent === null || renderer.isDestroyed
			? null
			: createPortal(
					<PluginUICustomPresentationLayer
						bounds={customContent.bounds}
						component={customContent.component}
						context={customContent.context}
						height={dimensions.height}
						isHidden={isPresentationHidden}
						request={activeRequest}
						theme={currentTheme}
						width={dimensions.width}
					/>,
					renderer.root,
					null,
					activeRequest.id
				);
	return (
		<>
			{renderWidgets("aboveEditor")}
			<box flexShrink={0} width="100%">
				{children}
			</box>
			{portal}
			{renderWidgets("belowEditor")}
		</>
	);
}

const successfulContribution: PluginUIContributionResult = Object.freeze({
	success: true,
});

const unsupportedThemeChange = (error: string): PluginThemeChangeResult => ({
	error,
	success: false,
});

const getPluginUIDialogTitle = (title: string, seconds?: number): string =>
	seconds === undefined ? title : `${title} (${seconds}s)`;

const getPluginUIDialogTimeoutError = (
	options: PluginUIDialogOptions | undefined
): RangeError | undefined => {
	const timeout = options?.timeout;
	return timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)
		? new RangeError("Plugin UI timeout must be a finite non-negative number.")
		: undefined;
};

const schedulePluginUIDialogTimers = (
	deadline: number | undefined,
	onExpire: () => void,
	onTick: (remainingSeconds: number) => void,
	isActive: () => boolean
): (() => void) => {
	if (deadline === undefined || !isActive()) {
		return () => undefined;
	}
	const cancelTimeout = schedulePluginUITimeout(
		Math.max(0, deadline - performance.now()),
		onExpire
	);
	const cancelTitleCountdown = schedulePluginUITitleCountdown(
		deadline,
		onTick,
		isActive
	);
	return () => {
		cancelTimeout();
		cancelTitleCountdown();
	};
};

type PluginUIDialogSettlement<Value> = Readonly<{
	cancel: () => void;
	finish: (value: Value, closeDialog?: boolean) => void;
	isSettled: () => boolean;
	onAbort: () => void;
	onDismiss: () => void;
	setCancelTimers: (cancel: () => void) => void;
	setEndPrompt: (end: () => void) => void;
}>;

const createPluginUIDialogSettlement = <Value,>(
	defaultValue: Value,
	activeRequests: Set<() => void>,
	dialog: DialogContextValue,
	layerId: string,
	signal: AbortSignal | undefined,
	resolve: (value: Value) => void
): PluginUIDialogSettlement<Value> => {
	let settled = false;
	let endPrompt = (): void => undefined;
	let cancelTimers = (): void => undefined;
	let cancel = (): void => undefined;
	const finish = (value: Value, closeDialog = true): void => {
		if (settled) {
			return;
		}
		settled = true;
		cancelTimers();
		signal?.removeEventListener("abort", onAbort);
		activeRequests.delete(cancel);
		endPrompt();
		if (closeDialog) {
			dialog.close(layerId);
		}
		resolve(value);
	};
	cancel = () => finish(defaultValue);
	const onAbort = (): void => cancel();
	const onDismiss = (): void => finish(defaultValue, false);
	activeRequests.add(cancel);
	return Object.freeze({
		cancel,
		finish,
		isSettled: () => settled,
		onAbort,
		onDismiss,
		setCancelTimers: (nextCancel) => {
			cancelTimers = nextCancel;
		},
		setEndPrompt: (end) => {
			endPrompt = end;
		},
	});
};

const updatePluginUIDialogCountdownTitle = (
	dialog: DialogContextValue,
	layerId: string,
	dialogTitle: string,
	displayedSeconds: { value: number | undefined },
	nextSeconds: number
): void => {
	if (nextSeconds === displayedSeconds.value) {
		return;
	}
	displayedSeconds.value = nextSeconds;
	dialog.updateTitle(layerId, getPluginUIDialogTitle(dialogTitle, nextSeconds));
};

type PluginUIDialogRequestParameters<Value> = Readonly<{
	activeRequests: Set<() => void>;
	beginPrompt: (kind: PluginUIPromptKind, title: string) => () => void;
	createContent: (resolve: (value: Value) => void) => ReactNode;
	defaultValue: Value;
	dialogTitle: string;
	getDialog: () => DialogContextValue;
	kind: PluginUIPromptKind;
	options: PluginUIDialogOptions | undefined;
	pluginId: string;
	promptTitle: string;
}>;

const openPluginUIDialogRequest = <Value,>(
	parameters: PluginUIDialogRequestParameters<Value>
): Promise<Value> => {
	const {
		activeRequests,
		beginPrompt,
		createContent,
		defaultValue,
		dialogTitle,
		getDialog,
		kind,
		options,
		pluginId,
		promptTitle,
	} = parameters;
	const signal = options?.signal;
	const timeout = options?.timeout;
	const result = Promise.withResolvers<Value>();
	const dialog = getDialog();
	const layerId = `plugin-ui-${pluginId}-${crypto.randomUUID()}`;
	const displayedSeconds = {
		value: timeout === undefined ? undefined : Math.ceil(timeout / 1000),
	};
	const settlement = createPluginUIDialogSettlement(
		defaultValue,
		activeRequests,
		dialog,
		layerId,
		signal,
		result.resolve
	);
	const { cancel, finish, onAbort, onDismiss } = settlement;
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) {
		cancel();
		return result.promise;
	}
	settlement.setEndPrompt(beginPrompt(kind, promptTitle));
	try {
		dialog.open({
			children: createElement(
				PluginDialogRequest,
				{
					escapeHandledByContent: isEscapeHandledByDialogContent(kind),
					onDismiss,
				},
				createContent((value) => finish(value))
			),
			layerId,
			title: getPluginUIDialogTitle(dialogTitle, displayedSeconds.value),
		});
	} catch (error) {
		finish(defaultValue, false);
		return Promise.reject(error);
	}
	const timeoutDeadline =
		timeout === undefined ? undefined : performance.now() + timeout;
	settlement.setCancelTimers(
		schedulePluginUIDialogTimers(
			timeoutDeadline,
			cancel,
			(nextSeconds) =>
				updatePluginUIDialogCountdownTitle(
					dialog,
					layerId,
					dialogTitle,
					displayedSeconds,
					nextSeconds
				),
			() => !settlement.isSettled()
		)
	);
	return result.promise;
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
	contributions,
	customUI,
	onUpdate,
	dialog: getDialog,
	keyboardLayer: getKeyboardLayer,
	theme: getThemeContext,
	toast: getToast,
}: PluginUIHostDependencies): PluginUIHost => {
	let activeCustomRequest: (() => void) | undefined;
	let hostClosed = false;
	const shortcutSubscriptions = new Set<() => void>();
	const terminalInputSubscriptions = new Set<() => void>();
	const textWidgetKeysByOwner = new Map<
		string,
		Map<string | undefined, Set<string>>
	>();
	const composers = new Map<
		string,
		Readonly<{ composer: PluginComposerHost }>
	>();
	const editorContributions = new Map<string, PluginEditorContribution>();
	const editorListeners = new Map<string, Set<() => void>>();
	const getTextWidgetKeys = (owner: PluginUIOwnerType): Set<string> => {
		let sessionKeys = textWidgetKeysByOwner.get(owner.pluginId);
		if (sessionKeys === undefined) {
			sessionKeys = new Map();
			textWidgetKeysByOwner.set(owner.pluginId, sessionKeys);
		}
		let widgetKeys = sessionKeys.get(owner.sessionId);
		if (widgetKeys === undefined) {
			widgetKeys = new Set();
			sessionKeys.set(owner.sessionId, widgetKeys);
		}
		return widgetKeys;
	};
	const clearTextWidgetKeys = (owner: PluginUIOwnerType): void => {
		const sessionKeys = textWidgetKeysByOwner.get(owner.pluginId);
		sessionKeys?.delete(owner.sessionId);
		if (sessionKeys?.size === 0) {
			textWidgetKeysByOwner.delete(owner.pluginId);
		}
	};
	const autocompleteProviders = new Map<
		string,
		PluginAutocompleteRegistration[]
	>();
	const autocompleteListeners = new Map<string, Set<() => void>>();
	const autocompleteProviderSnapshots = new Map<
		string,
		readonly PluginAutocompleteProviderFactory[]
	>();
	const notifyListeners = (
		listeners: Map<string, Set<() => void>>,
		sessionId: string
	): void => {
		for (const listener of [...(listeners.get(sessionId) ?? [])]) {
			listener();
		}
	};
	const releaseEditor = (owner: PluginUIOwnerType): void => {
		if (owner.sessionId === undefined) {
			return;
		}
		const contribution = editorContributions.get(owner.sessionId);
		if (contribution?.pluginId !== owner.pluginId) {
			return;
		}
		editorContributions.delete(owner.sessionId);
		notifyListeners(editorListeners, owner.sessionId);
	};
	const removeAutocompleteProvider = (
		registration: PluginAutocompleteRegistration
	): void => {
		const sessionId = registration.owner.sessionId;
		if (sessionId === undefined) {
			return;
		}
		const registrations = autocompleteProviders.get(sessionId);
		if (registrations === undefined) {
			return;
		}
		const next = registrations.filter(
			(candidate) => candidate !== registration
		);
		if (next.length === 0) {
			autocompleteProviders.delete(sessionId);
		} else {
			autocompleteProviders.set(sessionId, next);
		}
		notifyAutocompleteProviders(sessionId);
	};
	const notifyAutocompleteProviders = (sessionId: string): void => {
		autocompleteProviderSnapshots.delete(sessionId);
		notifyListeners(autocompleteListeners, sessionId);
	};
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
			const title = contributions.getTitle();
			contributions.close();
			if (title !== null) {
				createPluginUIUpdateControls(title.pluginId, (update) =>
					onUpdate?.(update)
				).setTitle(undefined);
			}
			composers.clear();
			textWidgetKeysByOwner.clear();
			editorContributions.clear();
			autocompleteProviders.clear();
			autocompleteProviderSnapshots.clear();
			editorListeners.clear();
			autocompleteListeners.clear();
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
		clearPlugin(pluginId) {
			textWidgetKeysByOwner.delete(pluginId);
			for (const update of contributions.clearPlugin(pluginId)) {
				onUpdate?.(update);
			}
			for (const [sessionId, contribution] of editorContributions) {
				if (contribution.pluginId === pluginId) {
					editorContributions.delete(sessionId);
					notifyListeners(editorListeners, sessionId);
				}
			}
			for (const registration of [...autocompleteProviders.values()].flat()) {
				if (registration.owner.pluginId === pluginId) {
					removeAutocompleteProvider(registration);
				}
			}
		},
		getChrome: contributions.getChromeSnapshot,
		getContributions: contributions.getSnapshot,
		getTitle: contributions.getTitle,
		setToolsExpanded(sessionId, expanded) {
			if (!hostClosed) {
				contributions.setToolsExpanded(sessionId, "\0host", expanded);
			}
		},
		bindComposer(sessionId, composer) {
			if (hostClosed) {
				return () => undefined;
			}
			const binding = Object.freeze({ composer });
			composers.set(sessionId, binding);
			return () => {
				if (composers.get(sessionId) === binding) {
					composers.delete(sessionId);
				}
			};
		},
		getComposer: (sessionId) => composers.get(sessionId)?.composer,
		getActiveEditorComponent: (sessionId) =>
			editorContributions.get(sessionId)?.component,
		subscribeEditor(sessionId, listener) {
			let listeners = editorListeners.get(sessionId);
			if (listeners === undefined) {
				listeners = new Set();
				editorListeners.set(sessionId, listeners);
			}
			listeners.add(listener);
			return () => {
				listeners?.delete(listener);
				if (
					listeners?.size === 0 &&
					editorListeners.get(sessionId) === listeners
				) {
					editorListeners.delete(sessionId);
				}
			};
		},
		getAutocompleteProviders(sessionId) {
			let snapshot = autocompleteProviderSnapshots.get(sessionId);
			if (snapshot === undefined) {
				snapshot = Object.freeze(
					(autocompleteProviders.get(sessionId) ?? []).map(
						({ provider }) => provider
					)
				);
				autocompleteProviderSnapshots.set(sessionId, snapshot);
			}
			return snapshot;
		},
		subscribeAutocompleteProviders(sessionId, listener) {
			let listeners = autocompleteListeners.get(sessionId);
			if (listeners === undefined) {
				listeners = new Set();
				autocompleteListeners.set(sessionId, listeners);
			}
			listeners.add(listener);
			return () => {
				listeners?.delete(listener);
				if (
					listeners?.size === 0 &&
					autocompleteListeners.get(sessionId) === listeners
				) {
					autocompleteListeners.delete(sessionId);
				}
			};
		},
		getCustomUI: customUI.get,
		subscribeChrome: contributions.subscribeChrome,
		subscribeTitle: contributions.subscribeTitle,
		subscribeContributions: contributions.subscribe,
		subscribeCustomUI: customUI.subscribe,
		create(owner, beginPrompt, invocation) {
			const activeRequests = new Set<() => void>();
			const ownerInputSubscriptions = new Set<() => void>();
			const autocompleteCleanup = new Set<() => void>();
			let closed = false;
			const updateControls = createPluginUIUpdateControls(
				owner.pluginId,
				(update) => onUpdate?.(update),
				getTextWidgetKeys(owner)
			);
			const getEditorComponent = (): PluginEditorComponent | undefined => {
				if (closed || hostClosed || owner.sessionId === undefined) {
					return;
				}
				const contribution = editorContributions.get(owner.sessionId);
				return contribution?.pluginId === owner.pluginId
					? contribution.component
					: undefined;
			};
			const setEditorComponent = (
				component: PluginEditorComponent | undefined
			): PluginUIContributionResult | undefined => {
				if (closed || hostClosed || owner.sessionId === undefined) {
					return;
				}
				const current = editorContributions.get(owner.sessionId);
				if (current !== undefined && current.pluginId !== owner.pluginId) {
					return {
						code: "plugin_ui_contribution_conflict",
						ownerPluginId: current.pluginId,
						success: false,
						surface: "editor",
					};
				}
				if (component === undefined) {
					releaseEditor(owner);
				} else {
					editorContributions.set(
						owner.sessionId,
						Object.freeze({ component, pluginId: owner.pluginId })
					);
					notifyListeners(editorListeners, owner.sessionId);
				}
				return { success: true };
			};
			const addAutocompleteProvider = (
				provider: PluginAutocompleteProviderFactory,
				options?: PluginAutocompleteProviderOptions
			): (() => void) => {
				if (closed || hostClosed || owner.sessionId === undefined) {
					return () => undefined;
				}
				const triggerCharacters =
					normalizeAutocompleteTriggerCharacters(options);
				const registeredProvider =
					triggerCharacters === undefined
						? provider
						: createTriggeredAutocompleteProvider(provider, triggerCharacters);
				const registration = Object.freeze({
					owner,
					provider: registeredProvider,
				});
				const registrations = autocompleteProviders.get(owner.sessionId) ?? [];
				autocompleteProviders.set(owner.sessionId, [
					...registrations,
					registration,
				]);
				notifyAutocompleteProviders(owner.sessionId);
				let registered = true;
				const unregister = (): void => {
					if (!registered) {
						return;
					}
					registered = false;
					autocompleteCleanup.delete(unregister);
					removeAutocompleteProvider(registration);
				};
				autocompleteCleanup.add(unregister);
				return unregister;
			};

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

				return openPluginUIDialogRequest({
					activeRequests,
					beginPrompt,
					createContent,
					defaultValue,
					dialogTitle,
					getDialog,
					kind,
					options,
					pluginId: owner.pluginId,
					promptTitle,
				});
			};

			const requestCustom = <Value,>(
				factory: PluginUICustomFactory<Value>,
				options: PluginUICustomOptions | undefined
			): Promise<Value | undefined> => {
				const sessionId = getAvailablePluginUISessionId(
					closed,
					hostClosed,
					owner.sessionId
				);
				if (sessionId === undefined) {
					return Promise.resolve(undefined);
				}
				const validation = getValidatedPluginUICustomOptions(options);
				if ("error" in validation) {
					return Promise.reject(validation.error);
				}
				const { options: validatedOptions } = validation;
				if (activeCustomRequest !== undefined) {
					return Promise.reject(
						new PluginUICustomError("plugin_ui_custom_busy")
					);
				}

				const result = Promise.withResolvers<Value | undefined>();
				const controller = new AbortController();
				const requestId = `plugin-custom-${crypto.randomUUID()}`;
				const invitationLayerId = `${requestId}-invitation`;
				const title = validatedOptions.title ?? "Custom Plugin UI";
				const presentationMode = validatedOptions.presentation ?? "editor";
				const presentationHandle = createPluginUICustomPresentationState();
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
					sessionId,
					signal: controller.signal,
					title,
					presentation: presentationMode,
					options: validatedOptions,
					presentationHandle,
				});
				activeCustomRequest = cancel;
				activeRequests.add(cancel);
				try {
					endPrompt = beginPrompt("custom", title);
				} catch (error) {
					fail(error);
					return result.promise;
				}

				invitationOpen = invocation !== "command";
				const dismissInvitation = (): void => {
					invitationOpen = false;
					if (!accepted) {
						finish(undefined, undefined, false);
					}
				};
				const accept = (): void => {
					if (
						!canAcceptPluginUICustomInvitation(settled, accepted, presentation)
					) {
						return;
					}
					accepted = true;
					invitationOpen = false;
					invitationDialog?.close(invitationLayerId);
					customUI.set(presentation);
				};
				invitationDialog = presentPluginUICustomRequest(
					presentation,
					owner.pluginId,
					invocation,
					customUI,
					getDialog,
					accept,
					dismissInvitation,
					cancel,
					fail
				);
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
				setStatus: (key, value) => {
					if (closed || hostClosed || owner.sessionId === undefined) {
						return;
					}
					contributions.setStatus(owner.sessionId, owner.pluginId, key, value);
					updateControls.setStatus(key, value);
				},
				setWidget: (key, content, options) => {
					if (closed || hostClosed || owner.sessionId === undefined) {
						return;
					}
					const placement = options?.placement ?? "aboveEditor";
					contributions.setWidget(
						owner.sessionId,
						owner.pluginId,
						key,
						content,
						placement
					);
					updateControls.setWidget(key, content, { placement });
				},
				setHeader: (component) => {
					if (closed || hostClosed) {
						return successfulContribution;
					}
					return contributions.setHeader(owner.pluginId, component);
				},
				setFooter: (component) => {
					if (closed || hostClosed) {
						return successfulContribution;
					}
					return contributions.setFooter(owner.pluginId, component);
				},
				setTitle: (title) => {
					if (closed || hostClosed) {
						return;
					}
					if (contributions.setTitle(owner.pluginId, title)) {
						updateControls.setTitle(title);
					}
				},
				setWorkingMessage: (message) => {
					if (!(closed || hostClosed) && owner.sessionId !== undefined) {
						contributions.setWorkingMessage(
							owner.sessionId,
							owner.pluginId,
							message
						);
					}
				},
				setWorkingVisible: (visible) => {
					if (!(closed || hostClosed) && owner.sessionId !== undefined) {
						contributions.setWorkingVisible(
							owner.sessionId,
							owner.pluginId,
							visible
						);
					}
				},
				setWorkingIndicator: (indicator) => {
					if (!(closed || hostClosed) && owner.sessionId !== undefined) {
						contributions.setWorkingIndicator(
							owner.sessionId,
							owner.pluginId,
							indicator
						);
					}
				},
				setHiddenThinkingLabel: (label) => {
					if (!(closed || hostClosed) && owner.sessionId !== undefined) {
						contributions.setHiddenThinkingLabel(
							owner.sessionId,
							owner.pluginId,
							label
						);
					}
				},
				getToolsExpanded: () =>
					owner.sessionId === undefined
						? false
						: (contributions.getSnapshot(owner.sessionId).toolsExpanded ??
							false),
				setToolsExpanded: (expanded) => {
					if (!(closed || hostClosed) && owner.sessionId !== undefined) {
						contributions.setToolsExpanded(
							owner.sessionId,
							owner.pluginId,
							expanded
						);
					}
				},
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
				getEditorText: () => {
					if (closed || hostClosed || owner.sessionId === undefined) {
						return;
					}
					return composers.get(owner.sessionId)?.composer.getText();
				},
				setEditorText: (text) => {
					if (closed || hostClosed || owner.sessionId === undefined) {
						return false;
					}
					return (
						composers.get(owner.sessionId)?.composer.setText(text) ?? false
					);
				},
				pasteToEditor: (text) => {
					if (closed || hostClosed || owner.sessionId === undefined) {
						return false;
					}
					return (
						composers.get(owner.sessionId)?.composer.pasteText(text) ?? false
					);
				},
				addAutocompleteProvider,
				getEditorComponent,
				setEditorComponent,
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
					if (owner.sessionId !== undefined) {
						clearTextWidgetKeys(owner);
						for (const update of contributions.clearView(
							owner.sessionId,
							owner.pluginId
						)) {
							onUpdate?.(update);
						}
					}
					releaseEditor(owner);
					for (const unregister of [...autocompleteCleanup]) {
						unregister();
					}
				},
				ui,
			});
		},
	});
};

const PluginUIHostContext = createContext<PluginUIHost | null>(null);

export function usePluginUIChrome(): PluginUIChromeSnapshot {
	const host = useOptionalPluginUIHost();
	const subscribe = useCallback(
		(listener: () => void) =>
			host?.subscribeChrome(listener) ?? (() => undefined),
		[host]
	);
	const getSnapshot = useCallback(
		() => host?.getChrome() ?? EMPTY_PLUGIN_UI_CHROME,
		[host]
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePluginUIContributions(
	sessionId: string
): PluginUIViewContributions {
	const host = useOptionalPluginUIHost();
	const subscribe = useCallback(
		(listener: () => void) =>
			host?.subscribeContributions(sessionId, listener) ?? (() => undefined),
		[host, sessionId]
	);
	const getSnapshot = useCallback(
		() => host?.getContributions(sessionId) ?? EMPTY_PLUGIN_UI_VIEW,
		[host, sessionId]
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function PluginUIContributionStatus({
	sessionId,
}: Readonly<{ sessionId: string }>) {
	const contributions = usePluginUIContributions(sessionId);
	const { colors } = useTheme();
	if (contributions.statuses.length === 0) {
		return null;
	}
	return (
		<box flexDirection="column" paddingX={1} width="100%">
			{contributions.statuses.map(({ key, pluginId, value }) => (
				<text
					fg={colors.textMuted}
					key={`${pluginId}:${key}`}
					width="100%"
					wrapMode="word"
				>
					{value}
				</text>
			))}
		</box>
	);
}

export function PluginUIHeader({
	children,
}: Readonly<{ children?: ReactNode }>) {
	const chrome = usePluginUIChrome();
	const { currentTheme } = useTheme();
	const { height, width } = useTerminalDimensions();
	if (chrome.header === null) {
		return children ?? null;
	}
	const context: PluginUIChromeContext = Object.freeze({
		height,
		theme: currentTheme,
		width,
	});
	return (
		<PluginUIChromeErrorBoundary
			component={chrome.header.component}
			fallback={children ?? null}
			key={chrome.header.revision}
			pluginId={chrome.header.pluginId}
			surface="header"
		>
			{createElement(chrome.header.component, context)}
		</PluginUIChromeErrorBoundary>
	);
}

export function PluginUIFooter({
	branch,
	children,
	sessionId,
}: Readonly<{
	branch?: string;
	children?: ReactNode;
	sessionId: string;
}>) {
	const chrome = usePluginUIChrome();
	const contributions = usePluginUIContributions(sessionId);
	const { currentTheme } = useTheme();
	const { height, width } = useTerminalDimensions();
	if (chrome.footer === null) {
		return children ?? null;
	}
	const context: PluginUIFooterContext = Object.freeze({
		height,
		statuses: contributions.statuses,
		theme: currentTheme,
		width,
		...omitUndefined({ branch }),
	});
	return (
		<PluginUIChromeErrorBoundary
			component={chrome.footer.component}
			fallback={children ?? null}
			key={chrome.footer.revision}
			pluginId={chrome.footer.pluginId}
			surface="footer"
		>
			{createElement(chrome.footer.component, context)}
		</PluginUIChromeErrorBoundary>
	);
}

export function PluginUIHostProvider({
	children,
	onUpdate,
}: Readonly<{
	children: ReactNode;
	onUpdate?: (update: PluginUIUpdate) => void;
}>) {
	const dialog = useDialog();
	const keyboardLayer = useKeyboardLayer();
	const theme = useTheme();
	const toast = useToast();
	const renderer = useRenderer();
	const customUI = useMemo(createPluginUICustomStore, []);
	const contributions = useMemo(createPluginUIContributionStore, []);
	const onUpdateRef = useRef(onUpdate);
	const dialogRef = useRef(dialog);
	const keyboardLayerRef = useRef(keyboardLayer);
	const themeRef = useRef(theme);
	const toastRef = useRef(toast);
	dialogRef.current = dialog;
	keyboardLayerRef.current = keyboardLayer;
	themeRef.current = theme;
	onUpdateRef.current = onUpdate;
	toastRef.current = toast;
	const host = useMemo(
		() =>
			createPluginUIHost({
				contributions,
				customUI,
				onUpdate: (update) => onUpdateRef.current?.(update),
				dialog: () => dialogRef.current,
				keyboardLayer: () => keyboardLayerRef.current,
				theme: () => themeRef.current,
				toast: () => toastRef.current,
			}),
		[contributions, customUI]
	);
	const subscribeTitle = useCallback(
		(listener: () => void) => host.subscribeTitle(listener),
		[host]
	);
	const getTitle = useCallback(() => host.getTitle(), [host]);
	const title = useSyncExternalStore(subscribeTitle, getTitle, getTitle);
	useEffect(() => {
		if (renderer.isRunning) {
			renderer.setTerminalTitle(title?.value ?? "");
		}
	}, [renderer, title]);
	useEffect(
		() => () => {
			if (renderer.isRunning) {
				renderer.setTerminalTitle("");
			}
		},
		[renderer]
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

const EMPTY_AUTOCOMPLETE_PROVIDERS: readonly PluginAutocompleteProviderFactory[] =
	Object.freeze([]);
const subscribeToNothing = (): (() => void) => () => undefined;

export function usePluginAutocompleteProviders(
	sessionId: string | undefined
): readonly PluginAutocompleteProviderFactory[] {
	const host = useOptionalPluginUIHost();
	const subscribe = useCallback(
		(listener: () => void) =>
			host === null || sessionId === undefined
				? subscribeToNothing()
				: host.subscribeAutocompleteProviders(sessionId, listener),
		[host, sessionId]
	);
	const getSnapshot = useCallback(
		() =>
			host === null || sessionId === undefined
				? EMPTY_AUTOCOMPLETE_PROVIDERS
				: host.getAutocompleteProviders(sessionId),
		[host, sessionId]
	);
	return useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => EMPTY_AUTOCOMPLETE_PROVIDERS
	);
}

export function PluginEditorSlot({
	context,
	sessionId,
}: Readonly<{
	context: PluginEditorContext;
	sessionId: string | undefined;
}>) {
	const host = useOptionalPluginUIHost();
	const subscribe = useCallback(
		(listener: () => void) =>
			host === null || sessionId === undefined
				? subscribeToNothing()
				: host.subscribeEditor(sessionId, listener),
		[host, sessionId]
	);
	const getSnapshot = useCallback(
		() =>
			host === null || sessionId === undefined
				? undefined
				: host.getActiveEditorComponent(sessionId),
		[host, sessionId]
	);
	const component = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => undefined
	);
	return component === undefined
		? context.defaultEditor
		: createElement(component, context);
}
