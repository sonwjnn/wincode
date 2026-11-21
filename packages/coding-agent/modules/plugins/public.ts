import type {
	AgentDefinition,
	AgentId,
	AgentTurnId,
	ToolCallId,
	ToolCallOutput,
	ToolCallRequest,
	ToolExecutionMode,
	ToolJsonSchema,
} from "@wincode/agent-core";
import type {
	Provider,
	ProviderModelSelection,
	ThinkingLevel,
} from "@wincode/ai";
import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { ExecutionMode } from "../../shared/execution-mode";
import type { Theme } from "../../shared/providers/theme/themes";

export type { Theme, ThemeColors } from "../../shared/providers/theme/themes";

import type { SessionHistoryEntryId } from "../../shared/identifiers";
import type { SessionMessage } from "../sessions/message";
import type {
	SessionSdkAgentSource,
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "../sessions/sdk-contract";
import type {
	PluginSessionHistory,
	PluginSessionHistoryEntry,
	PluginSessionHistoryReader,
} from "../sessions/session-plugin-history";
import type {
	PluginSessionStateJsonValue,
	PluginSessionStateRead,
} from "../sessions/session-plugin-state";
import type { SessionWriteOutcome } from "../sessions/session-write-outcome";

export type { SessionMessage } from "../sessions/message";
export type {
	PluginSessionHistory,
	PluginSessionHistoryEntry,
	PluginSessionHistoryReader,
} from "../sessions/session-plugin-history";

export type PluginJsonValue = PluginSessionStateJsonValue;

export type PluginSessionState = Readonly<{
	/** Reads a snapshot without adding it to the Session Context. */
	read: (key: string) => Promise<PluginSessionStateRead>;
	/** Replaces the complete value under key using a stable operation identity. */
	set: (
		key: string,
		value: PluginJsonValue,
		operationId: string
	) => Promise<void>;
	/** Appends a tombstone for key using a stable operation identity. */
	delete: (key: string, operationId: string) => Promise<void>;
}>;

export class PluginSessionStateVersionError extends Error {
	readonly code = "plugin_session_state_version_mismatch" as const;
	readonly storedSchemaVersion: number;

	constructor(storedSchemaVersion: number) {
		super(
			`Plugin Session State uses schema version ${storedSchemaVersion}, which this Plugin does not support.`
		);
		this.name = "PluginSessionStateVersionError";
		this.storedSchemaVersion = storedSchemaVersion;
	}
}

export class PluginSessionStateWriteError extends Error {
	readonly code = "plugin_session_state_write_failed" as const;
	readonly writeOutcome: SessionWriteOutcome;

	constructor(writeOutcome: SessionWriteOutcome, cause?: unknown) {
		super(
			"Plugin Session State was not durably committed.",
			cause === undefined ? undefined : { cause }
		);
		this.name = "PluginSessionStateWriteError";
		this.writeOutcome = writeOutcome;
	}
}

export class PluginSessionHistoryWriteError extends Error {
	readonly code = "plugin_session_history_write_failed" as const;
	readonly writeOutcome: SessionWriteOutcome;

	constructor(writeOutcome: SessionWriteOutcome, cause?: unknown) {
		super(
			"Plugin Session History entry was not durably committed.",
			cause === undefined ? undefined : { cause }
		);
		this.name = "PluginSessionHistoryWriteError";
		this.writeOutcome = writeOutcome;
	}
}

/** The outcome a Plugin Tool returns to Wincode. */
export type PluginToolResult = ToolCallOutput;
export type PluginInputSchema = z.ZodType | ToolJsonSchema;

export type PluginToolCallState =
	| "input-streaming"
	| "input-available"
	| "output-available"
	| "output-error"
	| "output-denied";

/** The current public Tool Call data shown while a Plugin Tool runs. */
export type PluginToolCall = ToolCallRequest &
	Readonly<{
		rawInput?: unknown;
		state: PluginToolCallState;
		toolName: string;
	}>;

export type PluginToolRenderContext = Readonly<{
	call: PluginToolCall;
	expanded: boolean;
	height: number;
	onToggleExpanded: () => void;
	theme: Theme;
	width: number;
}>;

/** A React presentation for one Plugin Tool Call, including its live state. */
export type PluginToolCallRenderer = ComponentType<PluginToolRenderContext>;

/** A React presentation for the current Plugin Tool result. */
export type PluginToolResultRenderer = ComponentType<
	PluginToolRenderContext & Readonly<{ result: PluginToolResult }>
>;

export type PluginRendererNext = () => ReactNode;

/** Higher values run first; equal priorities retain registration order. */
export type PluginRendererOptions = Readonly<{ priority?: number }>;

/** Markdown surfaces currently rendered by Interactive Mode. */
export type PluginMarkdownMessageType =
	| "assistant"
	| "assistant-thinking"
	| "summary"
	| "user";

export type PluginMarkdownTransformerContext = Readonly<{
	/** The host renderable's available width in terminal columns. */
	availableWidth: number;
	/** Whether the source content is still streaming. */
	isStreaming: boolean;
	/** Durable message or session-entry ID, when the host surface has one. */
	messageId: string | undefined;
	messageType: PluginMarkdownMessageType;
	/** Durable entry creation time in ISO format, when available. */
	timestamp: string | undefined;
}>;

export type PluginMarkdownTransformer = (
	markdown: string,
	context: PluginMarkdownTransformerContext
) => string;

export type PluginMarkdownTransformerOptions = Readonly<{
	messageTypes?: readonly PluginMarkdownMessageType[];
}>;

/** Resolver context for any host or Plugin Tool row. */
export type PluginToolRendererContext = PluginToolRenderContext &
	Readonly<{
		originPluginId: string | undefined;
		result?: PluginToolResult;
		type: string;
	}>;

/** Returns `undefined` to decline, or `next()` to delegate to later resolvers. */
export type PluginToolRenderer = (
	context: PluginToolRendererContext,
	next: PluginRendererNext
) => ReactNode | undefined;

/** Timeout and caller cancellation options for a blocking Plugin UI request. */
export type PluginUIDialogOptions = Readonly<{
	signal?: AbortSignal;
	timeout?: number;
}>;

export type PluginNotificationLevel = "info" | "warning" | "error";
export type PluginUIPromptKind =
	| "select"
	| "confirm"
	| "input"
	| "editor"
	| "custom";

export type PluginUICustomErrorCode =
	| "plugin_ui_custom_busy"
	| "plugin_ui_custom_failed"
	| "plugin_ui_custom_invalid_options";

/** A stable coded failure from a Plugin custom UI interaction. */
export class PluginUICustomError extends Error {
	readonly code: PluginUICustomErrorCode;

	constructor(code: PluginUICustomErrorCode, cause?: unknown) {
		let message: string;
		if (code === "plugin_ui_custom_busy") {
			message = "Another custom Plugin UI interaction is already active.";
		} else if (code === "plugin_ui_custom_invalid_options") {
			message = "Custom Plugin UI options are invalid.";
		} else {
			message = "The custom Plugin UI failed to execute.";
		}
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PluginUICustomError";
		this.code = code;
	}
}

type PluginUICustomComposerKeybinding = PluginEditorKeybinding;

export type PluginUICustomKeybindings = Readonly<{
	composer: readonly PluginUICustomComposerKeybinding[];
	dismiss: "escape";
	reclaim: "ctrl+c";
}>;

/** The host-owned placement used for a custom Plugin UI interaction. */
export type PluginUICustomPresentationMode =
	| "editor"
	| "overlay"
	| "full-screen";

export type PluginUICustomBounds = Readonly<{
	left: number;
	top: number;
	width: number;
	height: number;
}>;

export type PluginUICustomPresentationHandle = Readonly<{
	/** Mark the custom UI focused without changing its visibility or result. */
	focus: () => void;
	/** Mark the custom UI unfocused without changing its visibility or result. */
	unfocus: () => void;
	/** Hide or show the presentation without settling the interaction. */
	setHidden: (hidden: boolean) => void;
	/** Return whether the presentation is hidden. */
	isHidden: () => boolean;
	/** Return whether the presentation is focused. */
	isFocused: () => boolean;
	/** Return the current host-owned bounds in terminal cells. */
	getBounds: () => PluginUICustomBounds;
}>;

export type PluginUICustomContext<Value> = Readonly<{
	done: (value: Value) => void;
	environment: Readonly<{
		executionMode: "interactive";
		sessionId: string;
	}>;
	/** Available presentation height, updated when the terminal is resized. */
	height: number;
	keybindings: PluginUICustomKeybindings;
	/** Selected custom UI placement. */
	presentation: PluginUICustomPresentationMode;
	/** Host-owned focus, visibility, and bounds controls; these do not settle UI. */
	presentationHandle: PluginUICustomPresentationHandle;
	signal: AbortSignal;
	theme: Theme;
	/** Available presentation width, updated when the terminal is resized. */
	width: number;
}>;

/** A React component mounted by the host in the requested custom UI presentation. */
export type PluginUICustomComponent<Value> = ComponentType<
	PluginUICustomContext<Value>
>;

/** Returns the component type for an accepted custom UI interaction. */
export type PluginUICustomFactory<Value> = (
	context: PluginUICustomContext<Value>
) => PluginUICustomComponent<Value> | Promise<PluginUICustomComponent<Value>>;

export type PluginUICustomOverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export type PluginUICustomOverlayWidth = number | `${number}%`;

export type PluginUICustomOverlayPlacement = Readonly<{
	anchor?: PluginUICustomOverlayAnchor;
	width?: PluginUICustomOverlayWidth;
	maxHeight?: number;
	margin?: number;
}>;

export type PluginUICustomTerminalDimensions = Readonly<{
	width: number;
	height: number;
}>;

export type PluginUICustomOptions = Readonly<{
	/** Overlay-only position. Defaults to `center`. */
	anchor?: PluginUICustomOverlayAnchor;
	/** Overlay-only width in terminal cells or as a percentage. */
	width?: PluginUICustomOverlayWidth;
	/** Overlay-only height cap in terminal cells. Defaults to the host cap. */
	maxHeight?: number;
	/** Overlay-only uniform margin in terminal cells. Defaults to the host margin. */
	margin?: number;
	/** Overlay-only resolver, reevaluated on the initial layout and terminal resize. */
	resolvePlacement?: (
		dimensions: PluginUICustomTerminalDimensions
	) => PluginUICustomOverlayPlacement;
	/**
	 * Selects where the host presents custom UI: `editor` replaces the composer,
	 * `overlay` uses a bounded layer, and `full-screen` covers the app. All modes
	 * use the host's renderer and root. Defaults to `editor`.
	 */
	presentation?: PluginUICustomPresentationMode;
	title?: string;
}>;

export type PluginThemeChangeResult =
	| Readonly<{ success: true }>
	| Readonly<{ success: false; error: string }>;

export type PluginUIContributionSurface =
	| "header"
	| "footer"
	| "editor"
	| "entry"
	| "message";
export type PluginUIContributionResult =
	| Readonly<{ success: true }>
	| Readonly<{
			code: "plugin_ui_contribution_conflict";
			ownerPluginId?: string;
			success: false;
			surface: PluginUIContributionSurface;
	  }>;

export type PluginUIWidgetPlacement = "aboveEditor" | "belowEditor";
export type PluginUIWorkingIndicator = Readonly<{
	frames: readonly string[];
	intervalMs?: number;
}>;
export type PluginUIWidgetOptions = Readonly<{
	placement?: PluginUIWidgetPlacement;
}>;

export type PluginUIStatusContribution = Readonly<{
	key: string;
	pluginId: string;
	value: string;
}>;

export type PluginUIWidgetContribution =
	| Readonly<{
			component?: never;
			key: string;
			lines: readonly string[];
			placement: PluginUIWidgetPlacement;
			pluginId: string;
	  }>
	| Readonly<{
			component: PluginUIWidgetComponent;
			key: string;
			lines?: never;
			placement: PluginUIWidgetPlacement;
			pluginId: string;
	  }>;

/** Data-only status, widget, and title payloads for RPC UI update mapping. */
export type PluginUIUpdate =
	| Readonly<{
			type: "status";
			pluginId: string;
			key: string;
			value: string | null;
	  }>
	| Readonly<{
			type: "widget";
			pluginId: string;
			key: string;
			value: readonly string[] | null;
			placement: PluginUIWidgetPlacement;
	  }>
	| Readonly<{
			type: "title";
			pluginId: string;
			value: string | null;
	  }>;

export type PluginUIChromeContext = Readonly<{
	theme: Theme;
	width: number;
	height: number;
}>;

export type PluginUIHeaderComponent = ComponentType<PluginUIChromeContext>;
export type PluginUIWidgetContext = PluginUIChromeContext;
export type PluginUIWidgetComponent = ComponentType<PluginUIWidgetContext>;

export type PluginUIFooterContext = PluginUIChromeContext &
	Readonly<{
		branch?: string;
		statuses: readonly PluginUIStatusContribution[];
	}>;

export type PluginUIFooterComponent = ComponentType<PluginUIFooterContext>;

export type PluginUIDimensions = Readonly<{ height: number; width: number }>;
export type PluginMessageRole = "assistant" | "system" | "user";

export type PluginMessageRendererProps = Readonly<{
	dimensions: PluginUIDimensions;
	message: SessionMessage;
	options: Readonly<{ streaming: boolean }>;
	theme: Theme;
}>;

export type PluginMessageRendererContext = PluginMessageRendererProps &
	Readonly<{
		originPluginId: string | undefined;
		role: PluginMessageRole;
	}>;

/** Returns `undefined` to decline, or `next()` to delegate to later resolvers. */
export type PluginMessageRenderer = (
	context: PluginMessageRendererContext,
	next: PluginRendererNext
) => ReactNode | undefined;

export type PluginEntryRendererProps = Readonly<{
	dimensions: PluginUIDimensions;
	entry: PluginSessionHistoryEntry;
	options: Readonly<{ selectedPath: boolean }>;
	theme: Theme;
}>;

export type PluginEntryRendererContext = PluginEntryRendererProps &
	Readonly<{
		originPluginId: string;
		type: string;
	}>;

/** Returns `undefined` to decline, or `next()` to delegate to later resolvers. */
export type PluginEntryRenderer = (
	context: PluginEntryRendererContext,
	next: PluginRendererNext
) => ReactNode | undefined;

export type PluginAutocompleteItem = Readonly<{
	description?: string;
	label: string;
	value: string;
}>;

export type PluginAutocompleteResult = Readonly<{
	items: readonly PluginAutocompleteItem[];
	prefix: string;
}>;

export type PluginAutocompleteContext = Readonly<{
	column: number;
	cursorOffset: number;
	line: number;
	lines: readonly string[];
	sessionId: string;
	text: string;
}>;

export type PluginAutocompleteEdit = Readonly<{
	cursorOffset: number;
	text: string;
}>;

export type PluginAutocompleteProvider = Readonly<{
	getSuggestions: (
		context: PluginAutocompleteContext
	) =>
		| PluginAutocompleteResult
		| null
		| Promise<PluginAutocompleteResult | null>;
	applyCompletion: (
		context: PluginAutocompleteContext,
		item: PluginAutocompleteItem,
		prefix: string
	) => PluginAutocompleteEdit;
	shouldTriggerFileCompletion?: (context: PluginAutocompleteContext) => boolean;
}>;

export type PluginAutocompleteProviderFactory = (
	current: PluginAutocompleteProvider
) => PluginAutocompleteProvider;

export type PluginAutocompleteProviderOptions = Readonly<{
	triggerCharacters?: readonly string[];
}>;

export type PluginEditorKeybinding = Readonly<{
	action: string;
	ctrl?: boolean;
	meta?: boolean;
	name: string;
	shift?: boolean;
	super?: boolean;
}>;

export type PluginEditorContext = Readonly<{
	cursorOffset: number;
	defaultEditor: ReactNode;
	height: number;
	keybindings: readonly PluginEditorKeybinding[];
	nextPrompt: () => boolean;
	paste: (text: string) => boolean;
	previousPrompt: () => boolean;
	setText: (text: string, cursorOffset?: number) => void;
	submit: () => Promise<void>;
	text: string;
	theme: Theme;
	width: number;
}>;

/** A React editor mounted in place of the host editor or around its default slot. */
export type PluginEditorComponent = ComponentType<PluginEditorContext>;

export type PluginTerminalInputResult = Readonly<{ consume: true }> | undefined;
export type PluginTerminalInputHandler = (
	data: string
) => PluginTerminalInputResult;

/** UI-neutral operations the host makes available to a Plugin callback. */
export type PluginUI = Readonly<{
	select: (
		prompt: string,
		choices: readonly string[],
		options?: PluginUIDialogOptions
	) => Promise<string | undefined>;
	confirm: (
		title: string,
		message?: string,
		options?: PluginUIDialogOptions
	) => Promise<boolean>;
	input: (
		title: string,
		placeholder?: string,
		options?: PluginUIDialogOptions
	) => Promise<string | undefined>;
	editor: (
		title: string,
		initialValue?: string,
		options?: PluginUIDialogOptions
	) => Promise<string | undefined>;
	notify: (message: string, level?: PluginNotificationLevel) => void;
	getAllThemes: () => readonly Theme[];
	getTheme: (name: string) => Theme | undefined;
	setTheme: (theme: string | Theme) => PluginThemeChangeResult;
	custom: <Value>(
		factory: PluginUICustomFactory<Value>,
		options?: PluginUICustomOptions
	) => Promise<Value | undefined>;
	/** Sets or clears one Plugin-owned status value in the Session footer. */
	setStatus: (key: string, value: string | undefined) => void;
	/** Sets or clears one Plugin-owned widget above or below the composer. */
	setWidget: (
		key: string,
		content: readonly string[] | PluginUIWidgetComponent | undefined,
		options?: PluginUIWidgetOptions
	) => void;
	/** Registers or clears the Plugin-owned React header replacement. */
	setHeader: (
		component: PluginUIHeaderComponent | undefined
	) => PluginUIContributionResult;
	/** Registers or clears the Plugin-owned React footer replacement. */
	setFooter: (
		component: PluginUIFooterComponent | undefined
	) => PluginUIContributionResult;
	/** Overrides or restores the terminal title. */
	setTitle: (title?: string) => void;
	/** Overrides the built-in working text; undefined restores the default. */
	setWorkingMessage: (message?: string) => void;
	/** Shows or hides the built-in working indicator row. */
	setWorkingVisible: (visible: boolean) => void;
	/** Overrides the working indicator; undefined restores the default spinner. */
	setWorkingIndicator: (indicator?: PluginUIWorkingIndicator) => void;
	/** Overrides the label shown instead of hidden reasoning content. */
	setHiddenThinkingLabel: (label?: string) => void;
	getToolsExpanded: () => boolean;
	setToolsExpanded: (expanded: boolean) => void;
	/** Observes raw terminal sequences in Interactive Mode; return consume to stop host parsing. */
	onTerminalInput: (handler: PluginTerminalInputHandler) => () => void;
	getEditorText: () => string | undefined;
	setEditorText: (text: string) => boolean;
	pasteToEditor: (text: string) => boolean;
	addAutocompleteProvider: (
		provider: PluginAutocompleteProviderFactory,
		options?: PluginAutocompleteProviderOptions
	) => () => void;
	getEditorComponent: () => PluginEditorComponent | undefined;
	setEditorComponent: (
		component: PluginEditorComponent | undefined
	) => PluginUIContributionResult | undefined;
}>;

export type PluginUIContext = Readonly<{ ui: PluginUI }>;

export type PluginUIPromptContext = Readonly<{
	executionMode?: ExecutionMode;
	kind: PluginUIPromptKind;
	pluginId: string;
	reason: "ui_prompt";
	sessionId?: string;
	title: string;
}>;

export type PluginConfigOrigin = Readonly<{
	path: string;
	scope: string;
}>;

export type PluginConfigDiagnostic = PluginConfigOrigin &
	Readonly<{
		code: "duplicate-config" | "parse-error" | "read-error" | "unsafe-key";
		message: string;
	}>;

export type PluginConfigSource = PluginConfigOrigin &
	Readonly<{ document: Readonly<Record<string, unknown>> }>;

export type PluginConfigSnapshot = Readonly<{
	diagnostics: readonly PluginConfigDiagnostic[];
	document: Readonly<Record<string, unknown>>;
	sourceFor: (path: readonly string[]) => PluginConfigOrigin | undefined;
	sources: readonly PluginConfigSource[];
}>;

/** Read-only access to the host's merged config, including refresh and provenance. */
export type PluginConfigReader = Readonly<{
	getSnapshot: () => Promise<PluginConfigSnapshot>;
	refreshSnapshot: () => Promise<PluginConfigSnapshot>;
}>;

export type PluginMcpServerRegistration = Readonly<{
	config: PluginJsonValue;
	name: string;
	ownerPluginId: string;
}>;

export type PluginConfigFileStore = Readonly<{
	getSnapshot: (namespace: string) => Promise<PluginConfigSnapshot>;
	refreshSnapshot: (namespace: string) => Promise<PluginConfigSnapshot>;
	setValue: (
		namespace: string,
		scope: "global" | "project",
		path: readonly string[],
		value: PluginJsonValue | undefined,
		targetPath?: string
	) => Promise<PluginConfigSnapshot>;
}>;

export type PluginProviderConnectContext = PluginUIContext &
	Readonly<{
		requestTextInput: (
			prompt: string,
			signal: AbortSignal
		) => Promise<string | undefined>;
		signal: AbortSignal;
	}>;

/** A trusted Plugin's factory and host-mediated connection interaction. */
export type PluginProviderRegistration = Readonly<{
	connect: (
		context: PluginProviderConnectContext
	) => Promise<PluginJsonValue | undefined>;
	createProvider: () => Provider;
	displayName: string;
	providerId: string;
}>;

export type PluginStatus = "idle" | "pending" | "success" | "warning" | "error";

export type PluginStatusAction = Readonly<{
	id: string;
	label: string;
	shortcut?: "space";
}>;

export type PluginStatusItem = Readonly<{
	actions?: readonly PluginStatusAction[];
	detail?: string;
	id: string;
	label: string;
	status: PluginStatus;
	summary?: string;
}>;

export type PluginStatusPanelSnapshot = Readonly<{
	items: readonly PluginStatusItem[];
	status?: PluginStatus;
	summary?: string;
}>;

/** Declarative host-rendered status and controls contributed by a Plugin. */
export type PluginStatusPanelActionContext = PluginUIContext &
	Readonly<{
		requestTextInput: (
			prompt: string,
			signal: AbortSignal
		) => Promise<string | undefined>;
	}>;

export type PluginStatusPanelRegistration = Readonly<{
	emptyText?: string;
	getSnapshot: () => PluginStatusPanelSnapshot;
	indicatorLabel?: string;
	id: string;
	refresh?: () => Promise<void>;
	runAction: (
		itemId: string,
		actionId: string,
		context?: PluginStatusPanelActionContext
	) => Promise<void>;
	subscribe: (listener: () => void) => () => void;
	title: string;
}>;

export type PluginAgentScope = Exclude<SessionSdkAgentSource, "global">;

export type PluginAgentRegistration = Readonly<{
	agent: AgentDefinition;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	requiredTools?: readonly string[];
	source: Readonly<{
		path: string;
		projectRoot?: string;
		scope: PluginAgentScope;
	}>;
	tools?: readonly string[];
}>;

export type PluginLoadContext = Readonly<{
	config: PluginConfigReader;
	configFiles: PluginConfigFileStore;
	getMcpServerRegistrations: () => readonly PluginMcpServerRegistration[];
	trustedProjectRoots?: readonly string[];
	sourcePath: string;
	/** Shared user-data root; Plugins choose and secure their own storage beneath it. */
	userDataDir: string;
	workspace: string;
}>;

export type PluginSessionContext = Readonly<{
	executionMode?: ExecutionMode;
	sessionId: string;
	sessionSdk?: SessionSdkOperations;
	sessionHistory?: PluginSessionHistory;
	sessionState?: PluginSessionState;
	workspace: string;
}>;

export type PluginSessionHookContext = PluginSessionContext & PluginUIContext;

type PluginSessionHistoryNavigationFields = Readonly<{
	fromEntryId: SessionHistoryEntryId | null;
	historyGeneration: number;
	operationId: string;
	toEntryId: SessionHistoryEntryId | null;
}>;

/** Session Host input used to report a completed history navigation. */
export type PluginSessionHistoryNavigationInputContext = PluginSessionContext &
	PluginSessionHistoryNavigationFields;

/** Plugin callback context for a completed history navigation. */
export type PluginSessionHistoryNavigationContext = PluginSessionHookContext &
	PluginSessionHistoryNavigationFields;

export type PluginBeforeSessionHistoryNavigationContext = Omit<
	PluginSessionHookContext & PluginSessionHistoryNavigationFields,
	"sessionHistory" | "sessionState"
> &
	Readonly<{
		sessionHistory?: PluginSessionHistoryReader;
		sessionState?: Pick<PluginSessionState, "read">;
	}>;

export type PluginBeforeAgentTurnInputContext = PluginSessionContext &
	Readonly<{
		agentId: AgentId;
		capabilityCeiling?: SessionSdkCapabilityCeiling;
		registerTurnCleanup?: (cleanup: () => void) => void;
		signal: AbortSignal;
		turnId?: AgentTurnId;
	}>;

export type PluginBeforeAgentTurnContext = PluginSessionHookContext &
	Readonly<{
		agentId: AgentId;
		capabilityCeiling?: SessionSdkCapabilityCeiling;
		registerTurnCleanup?: (cleanup: () => void) => void;
		signal: AbortSignal;
		turnId?: AgentTurnId;
	}>;

export type PluginProcessContext = Readonly<{
	sourcePath: string;
	workspace: string;
}>;

/** Why compaction ran: an operator request, a threshold check, or overflow recovery. */
export type PluginCompactionTrigger = "manual" | "overflow" | "threshold";

export type PluginCompactionInputContext = PluginSessionContext &
	Readonly<{
		focus?: string;
		signal: AbortSignal;
		trigger: PluginCompactionTrigger;
		turnId?: AgentTurnId;
	}>;

export type PluginCompactionContext = PluginSessionHookContext &
	Readonly<{
		focus?: string;
		signal: AbortSignal;
		trigger: PluginCompactionTrigger;
		turnId?: AgentTurnId;
	}>;

/**
 * A pre-compaction decision. `cancel` refuses the compaction with its message.
 * `summary` supplies the handoff text instead of calling a summary model; the
 * Session Host still applies its own budgets, reduction and persistence rules.
 */
export type PluginBeforeCompactionResult =
	| Readonly<{ cancel: string; summary?: never }>
	| Readonly<{ cancel?: never; summary: string }>
	| undefined;

type PluginCompactionCompletedFields = Readonly<{
	compactionId: string;
	estimatedTokensAfter: number;
	tokensBefore: number;
}>;

export type PluginCompactionCompletedInputContext =
	PluginCompactionInputContext & PluginCompactionCompletedFields;

export type PluginCompactionCompletedContext = PluginCompactionContext &
	PluginCompactionCompletedFields;

export type PluginCompactionFailedInputContext = PluginCompactionInputContext &
	Readonly<{ error: string }>;

export type PluginCompactionFailedContext = PluginCompactionContext &
	Readonly<{ error: string }>;

export type PluginToolContext = PluginSessionHookContext &
	Readonly<{
		agentId: AgentId;
		signal: AbortSignal;
		toolCallId: ToolCallId;
		registerBackgroundWork: (work: Promise<unknown>) => void;
	}>;

export type PluginCommandInputContext = Readonly<{
	argument: string;
	executionMode?: ExecutionMode;
	sessionHistory?: PluginSessionHistory;
	sessionId?: string;
	sessionState?: PluginSessionState;
	workspace: string;
}>;

export type PluginCommandContext = PluginCommandInputContext & PluginUIContext;

export type PluginToolRegistration<Schema extends PluginInputSchema> =
	Readonly<{
		description: string;
		exclusiveInBatch?: true;
		executionMode?: ToolExecutionMode;
		handler: (
			input: Schema extends z.ZodType ? z.output<Schema> : unknown,
			context: PluginToolContext
		) => PluginToolResult | Promise<PluginToolResult>;
		inputSchema: Schema;
		modelName?: string;
		name: string;
		ownsRowShell?: boolean;
		renderCall?: PluginToolCallRenderer;
		renderResult?: PluginToolResultRenderer;
	}>;

export type PluginCommandHandler = (
	context: PluginCommandContext
) => string | Promise<string>;

export type PluginCommandArgumentCompletion = (
	prefix: string
) =>
	| readonly PluginAutocompleteItem[]
	| null
	| Promise<readonly PluginAutocompleteItem[] | null>;

export type PluginCommandRegistration = Readonly<{
	description: string;
	name: string;
}> &
	(
		| Readonly<{
				getArgumentCompletions?: PluginCommandArgumentCompletion;
				handler: PluginCommandHandler;
				statusPanelId?: never;
		  }>
		| Readonly<{
				getArgumentCompletions?: never;
				handler?: never;
				statusPanelId: string;
		  }>
	);

export type PluginToolRegistrationAPI = Readonly<{
	registerTool: <Schema extends PluginInputSchema>(
		tool: PluginToolRegistration<Schema>
	) => void;
	unregisterTool: (name: string) => void;
}>;

export type PluginRegistrationAPI = PluginToolRegistrationAPI &
	Readonly<{
		registerCommand: (command: PluginCommandRegistration) => void;
	}>;

export type PluginShortcutContext = PluginUIContext &
	Readonly<{
		pluginId: string;
		sessionId: string;
		shortcut: string;
	}>;

export type PluginShortcutHandler = (
	context: PluginShortcutContext
) => void | Promise<void>;

export type PluginShortcutOptions = Readonly<{
	description: string;
	handler: PluginShortcutHandler;
}>;

export type PluginShortcutRegistration = PluginShortcutOptions &
	Readonly<{ shortcut: string }>;

export type PluginSessionStartHook = (
	context: PluginSessionHookContext,
	api: PluginRegistrationAPI
) => void | Promise<void>;

export type PluginSessionShutdownHook = (
	context: PluginSessionHookContext
) => void | Promise<void>;

export type PluginBeforeSessionHistoryNavigationResult =
	| Readonly<{ cancel: string }>
	| undefined;

export type PluginBeforeSessionHistoryNavigationHook = (
	context: PluginBeforeSessionHistoryNavigationContext
) =>
	| PluginBeforeSessionHistoryNavigationResult
	| Promise<PluginBeforeSessionHistoryNavigationResult>;

export type PluginSessionHistoryNavigatedHook = (
	context: PluginSessionHistoryNavigationContext
) => void | Promise<void>;

export type PluginUIPromptHook = (
	context: PluginUIPromptContext
) => void | Promise<void>;

export type PluginBeforeAgentTurnHook = (
	context: PluginBeforeAgentTurnContext,
	api: PluginToolRegistrationAPI
) => void | Promise<void>;

export type PluginBeforeCompactionHook = (
	context: PluginCompactionContext
) => PluginBeforeCompactionResult | Promise<PluginBeforeCompactionResult>;

export type PluginCompactionCompletedHook = (
	context: PluginCompactionCompletedContext
) => void | Promise<void>;

export type PluginCompactionFailedHook = (
	context: PluginCompactionFailedContext
) => void | Promise<void>;

export type PluginShutdownHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginProcessStartHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginDefinitionAPI = PluginRegistrationAPI &
	Readonly<{
		registerProvider: (provider: PluginProviderRegistration) => void;
		registerMcpServer: (name: string, config: PluginJsonValue) => void;
		registerAgent: (agent: PluginAgentRegistration) => void;
		registerResource: (name: string, resource: unknown) => void;
		registerStatusPanel: (panel: PluginStatusPanelRegistration) => void;
		registerShortcut: (
			shortcut: string,
			options: PluginShortcutOptions
		) => void;
		onSessionStart: (handler: PluginSessionStartHook) => void;
		onSessionShutdown: (handler: PluginSessionShutdownHook) => void;
		onBeforeSessionHistoryNavigation: (
			handler: PluginBeforeSessionHistoryNavigationHook
		) => void;
		onSessionHistoryNavigated: (
			handler: PluginSessionHistoryNavigatedHook
		) => void;
		onBeforeAgentTurn: (handler: PluginBeforeAgentTurnHook) => void;
		onBeforeCompaction: (handler: PluginBeforeCompactionHook) => void;
		onCompactionCompleted: (handler: PluginCompactionCompletedHook) => void;
		onCompactionFailed: (handler: PluginCompactionFailedHook) => void;
		onUIPromptStart: (handler: PluginUIPromptHook) => void;
		onUIPromptEnd: (handler: PluginUIPromptHook) => void;
		onStart: (handler: PluginProcessStartHook) => void;
		onShutdown: (handler: PluginShutdownHook) => void;
	}>;

export type PluginAPI = Readonly<{
	definePlugin: (
		identity: Readonly<{ id: string; sessionStateVersion?: number }>
	) => PluginDefinitionAPI;
	registerToolRenderer: (
		renderer: PluginToolRenderer,
		options?: PluginRendererOptions
	) => PluginUIContributionResult;
	registerEntryRenderer: (
		renderer: PluginEntryRenderer,
		options?: PluginRendererOptions
	) => PluginUIContributionResult;
	registerMessageRenderer: (
		renderer: PluginMessageRenderer,
		options?: PluginRendererOptions
	) => PluginUIContributionResult;
	registerMarkdownTransformer: (
		transformer: PluginMarkdownTransformer,
		options?: PluginMarkdownTransformerOptions
	) => void;
	/** Registers a shortcut for the Plugin declared with definePlugin(). */
	registerShortcut: (shortcut: string, options: PluginShortcutOptions) => void;
	/** Set the focused Interactive composer model for future Submissions. */
	setModel: (model: ProviderModelSelection) => Promise<boolean>;
	/** Set or clear the focused composer ThinkingLevel for future Submissions; unsupported levels are ignored. */
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

/** The default export of an enabled Plugin file. */
export type PluginFactory = (
	api: PluginAPI,
	context: PluginLoadContext
) => void | Promise<void>;
