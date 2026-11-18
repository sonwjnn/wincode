import { logger } from "@wincode/utils";
import type {
	PluginNotificationLevel,
	PluginUI,
	PluginUIDialogOptions,
	PluginUIPromptKind,
} from "@/modules/plugins/public";
import { createPluginUIUpdateControls } from "@/modules/plugins/ui/plugin-ui-contributions";
import { unsupportedPluginUI } from "@/modules/plugins/ui/plugin-ui-default";
import type {
	PluginUIHandle,
	PluginUIHostBinding,
	PluginUIUpdate,
} from "@/modules/plugins/ui/plugin-ui-host-contract";
import {
	PLUGIN_SESSION_STATE_MAX_PLUGIN_ID_BYTES,
	validatePluginSessionStatePluginId,
} from "@/modules/sessions/session-plugin-state";

export const RPC_PLUGIN_UI_CAPABILITY_VERSION = 1 as const;
export const RPC_PLUGIN_UI_METHODS = [
	"plugin/ui/request",
	"plugin/ui/notify",
	"plugin/ui/update",
] as const;

export type RpcPluginUIRequest =
	| Readonly<{
			pluginId: string;
			kind: "select";
			title: string;
			choices: readonly string[];
			timeoutMs?: number;
	  }>
	| Readonly<{
			pluginId: string;
			kind: "confirm";
			title: string;
			message?: string;
			timeoutMs?: number;
	  }>
	| Readonly<{
			pluginId: string;
			kind: "input";
			title: string;
			placeholder?: string;
			timeoutMs?: number;
	  }>
	| Readonly<{
			pluginId: string;
			kind: "editor";
			title: string;
			initialValue?: string;
			timeoutMs?: number;
	  }>;

export type RpcPluginUIWireResult = string | boolean | null;

export type RpcPluginUINotification = Readonly<{
	pluginId: string;
	message: string;
	level: PluginNotificationLevel;
}>;

export type RpcPluginUIUpdate = PluginUIUpdate;

type RpcPluginUIWidgetPlacement = Extract<
	PluginUIUpdate,
	{ type: "widget" }
>["placement"];

type RpcPluginUIContributionState = {
	statusKeys: Set<string>;
	widgetPlacements: Map<string, RpcPluginUIWidgetPlacement>;
};

export type RpcPluginUIRequestTransport = Readonly<{
	request: (
		request: RpcPluginUIRequest,
		signal?: AbortSignal
	) => Promise<RpcPluginUIWireResult>;
	notify: (notification: RpcPluginUINotification) => void;
	update: (update: RpcPluginUIUpdate) => void;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
	value: Record<string, unknown>,
	keys: readonly string[]
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isPluginIdentifier = (value: unknown): value is string => {
	if (
		typeof value !== "string" ||
		value.length > PLUGIN_SESSION_STATE_MAX_PLUGIN_ID_BYTES
	) {
		return false;
	}
	try {
		validatePluginSessionStatePluginId(value);
		return true;
	} catch {
		return false;
	}
};

const isOptionalString = (value: unknown): boolean =>
	value === undefined || typeof value === "string";

const isOptionalTimeout = (value: unknown): boolean =>
	value === undefined ||
	(typeof value === "number" && Number.isFinite(value) && value >= 0);

export const isRpcPluginUIRequest = (
	value: unknown
): value is RpcPluginUIRequest => {
	if (
		!(
			isRecord(value) &&
			isPluginIdentifier(value.pluginId) &&
			isOptionalTimeout(value.timeoutMs)
		) ||
		typeof value.title !== "string"
	) {
		return false;
	}
	switch (value.kind) {
		case "select":
			return (
				hasOnlyKeys(value, [
					"pluginId",
					"kind",
					"title",
					"choices",
					"timeoutMs",
				]) &&
				Array.isArray(value.choices) &&
				value.choices.every((choice) => typeof choice === "string")
			);
		case "confirm":
			return (
				hasOnlyKeys(value, [
					"pluginId",
					"kind",
					"title",
					"message",
					"timeoutMs",
				]) && isOptionalString(value.message)
			);
		case "input":
			return (
				hasOnlyKeys(value, [
					"pluginId",
					"kind",
					"title",
					"placeholder",
					"timeoutMs",
				]) && isOptionalString(value.placeholder)
			);
		case "editor":
			return (
				hasOnlyKeys(value, [
					"pluginId",
					"kind",
					"title",
					"initialValue",
					"timeoutMs",
				]) && isOptionalString(value.initialValue)
			);
		default:
			return false;
	}
};

export const isRpcPluginUINotification = (
	value: unknown
): value is RpcPluginUINotification =>
	isRecord(value) &&
	hasOnlyKeys(value, ["pluginId", "message", "level"]) &&
	isPluginIdentifier(value.pluginId) &&
	typeof value.message === "string" &&
	(value.level === "info" ||
		value.level === "warning" ||
		value.level === "error");

export const isRpcPluginUIUpdate = (
	value: unknown
): value is RpcPluginUIUpdate => {
	if (!(isRecord(value) && isPluginIdentifier(value.pluginId))) {
		return false;
	}
	switch (value.type) {
		case "status":
			return (
				hasOnlyKeys(value, ["type", "pluginId", "key", "value"]) &&
				typeof value.key === "string" &&
				(value.value === null || typeof value.value === "string")
			);
		case "widget":
			return (
				hasOnlyKeys(value, ["type", "pluginId", "key", "value", "placement"]) &&
				typeof value.key === "string" &&
				(value.value === null ||
					(Array.isArray(value.value) &&
						value.value.every((line) => typeof line === "string"))) &&
				(value.placement === "aboveEditor" || value.placement === "belowEditor")
			);
		case "title":
			return (
				hasOnlyKeys(value, ["type", "pluginId", "value"]) &&
				(value.value === null || typeof value.value === "string")
			);
		default:
			return false;
	}
};

const timeoutError = (
	options: PluginUIDialogOptions | undefined
): RangeError | undefined => {
	const timeout = options?.timeout;
	return timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)
		? new RangeError("Plugin UI timeout must be a finite non-negative number.")
		: undefined;
};

const requestResult = (
	kind: PluginUIPromptKind,
	value: RpcPluginUIWireResult
): string | boolean | undefined => {
	if (kind === "confirm") {
		return typeof value === "boolean" ? value : false;
	}
	return typeof value === "string" ? value : undefined;
};

type RpcPluginUIDialogFields = Readonly<{
	choices?: readonly string[];
	initialValue?: string;
	message?: string;
	placeholder?: string;
}>;

type RpcPluginUIDialogPreparation =
	| Readonly<{ kind: "default" }>
	| Readonly<{ kind: "error"; error: RangeError }>
	| Readonly<{ kind: "ready"; signal: AbortSignal }>;

const prepareRpcPluginUIDialog = (
	closed: boolean,
	handleClosed: boolean,
	controller: AbortController,
	options: PluginUIDialogOptions | undefined
): RpcPluginUIDialogPreparation => {
	if (closed || handleClosed || options?.signal?.aborted) {
		return { kind: "default" };
	}
	const error = timeoutError(options);
	if (error !== undefined) {
		return { error, kind: "error" };
	}
	if (options?.timeout === 0) {
		return { kind: "default" };
	}
	const signal =
		options?.signal === undefined
			? controller.signal
			: AbortSignal.any([controller.signal, options.signal]);
	return signal.aborted ? { kind: "default" } : { kind: "ready", signal };
};

const settleRpcPluginUIDialog = <Value extends string | boolean | undefined>(
	transport: RpcPluginUIRequestTransport,
	request: RpcPluginUIRequest,
	signal: AbortSignal,
	kind: PluginUIPromptKind,
	endPrompt: () => void,
	_defaultValue: Value
): Promise<Value> => {
	try {
		return transport
			.request(request, signal)
			.then((value) => requestResult(kind, value) as Value)
			.finally(endPrompt);
	} catch (error) {
		endPrompt();
		return Promise.reject(error);
	}
};

/** Builds a React-free Plugin UI host for capability-negotiated RPC clients. */
export const createRpcPluginUIHost = (
	transport: RpcPluginUIRequestTransport
): PluginUIHostBinding => {
	let closed = false;
	const handles = new Set<PluginUIHandle>();
	const contributions = new Map<string, RpcPluginUIContributionState>();
	let titleOwner: string | undefined;
	const sendUpdate = (update: PluginUIUpdate): void => {
		if (closed || !isRpcPluginUIUpdate(update)) {
			return;
		}
		transport.update(update);
	};
	const trackTitleUpdate = (
		update: Extract<PluginUIUpdate, { type: "title" }>
	): boolean => {
		if (update.value === null && titleOwner !== update.pluginId) {
			return false;
		}
		titleOwner = update.value === null ? undefined : update.pluginId;
		return true;
	};
	const trackKeyedUpdate = (
		update: Extract<PluginUIUpdate, { type: "status" | "widget" }>
	): void => {
		let state = contributions.get(update.pluginId);
		if (state === undefined) {
			if (update.value === null) {
				return;
			}
			state = { statusKeys: new Set(), widgetPlacements: new Map() };
			contributions.set(update.pluginId, state);
		}
		if (update.type === "status") {
			if (update.value === null) {
				state.statusKeys.delete(update.key);
			} else {
				state.statusKeys.add(update.key);
			}
		} else if (update.value === null) {
			state.widgetPlacements.delete(update.key);
		} else {
			state.widgetPlacements.set(update.key, update.placement);
		}
		if (state.statusKeys.size === 0 && state.widgetPlacements.size === 0) {
			contributions.delete(update.pluginId);
		}
	};
	const trackUpdate = (update: PluginUIUpdate): boolean => {
		if (update.type === "title") {
			return trackTitleUpdate(update);
		}
		trackKeyedUpdate(update);
		return true;
	};
	const publishUpdate = (update: PluginUIUpdate): void => {
		if (closed || !isRpcPluginUIUpdate(update) || !trackUpdate(update)) {
			return;
		}
		transport.update(update);
	};
	const clearPluginContributions = (pluginId: string): void => {
		const state = contributions.get(pluginId);
		const ownsTitle = titleOwner === pluginId;
		if (state === undefined && !ownsTitle) {
			return;
		}
		if (state !== undefined) {
			contributions.delete(pluginId);
			for (const key of state.statusKeys) {
				sendUpdate({ key, pluginId, type: "status", value: null });
			}
			for (const [key, placement] of state.widgetPlacements) {
				sendUpdate({
					key,
					placement,
					pluginId,
					type: "widget",
					value: null,
				});
			}
		}
		if (ownsTitle) {
			titleOwner = undefined;
			sendUpdate({ pluginId, type: "title", value: null });
		}
	};
	return Object.freeze({
		clearPlugin(pluginId) {
			clearPluginContributions(pluginId);
		},
		close() {
			if (closed) {
				return;
			}
			const pluginIds = new Set(contributions.keys());
			if (titleOwner !== undefined) {
				pluginIds.add(titleOwner);
			}
			for (const pluginId of pluginIds) {
				clearPluginContributions(pluginId);
			}
			closed = true;
			for (const handle of [...handles]) {
				handle.close();
			}
		},
		create(owner, beginPrompt, _invocation) {
			const controller = new AbortController();
			let handleClosed = false;
			const updateControls = createPluginUIUpdateControls(
				owner.pluginId,
				(update) => {
					if (!handleClosed) {
						publishUpdate(update);
					}
				}
			);
			const request = <Value extends string | boolean | undefined>(
				kind: Exclude<PluginUIPromptKind, "custom">,
				title: string,
				fields: RpcPluginUIDialogFields,
				defaultValue: Value,
				options?: PluginUIDialogOptions
			): Promise<Value> => {
				const preparation = prepareRpcPluginUIDialog(
					closed,
					handleClosed,
					controller,
					options
				);
				if (preparation.kind === "default") {
					return Promise.resolve(defaultValue);
				}
				if (preparation.kind === "error") {
					return Promise.reject(preparation.error);
				}
				let endPrompt = (): void => undefined;
				try {
					endPrompt = beginPrompt(kind, title);
				} catch (error) {
					return Promise.reject(error);
				}
				const rpcRequest = {
					...fields,
					...(options?.timeout === undefined
						? {}
						: { timeoutMs: options.timeout }),
					kind,
					pluginId: owner.pluginId,
					title,
				} as RpcPluginUIRequest;
				if (!isRpcPluginUIRequest(rpcRequest)) {
					endPrompt();
					void logger.warn("Invalid RPC Plugin UI request was ignored", {
						operation: "rpc.plugin-ui.request",
						pluginId: owner.pluginId,
					});
					return Promise.resolve(defaultValue);
				}
				return settleRpcPluginUIDialog(
					transport,
					rpcRequest,
					preparation.signal,
					kind,
					endPrompt,
					defaultValue
				);
			};
			const ui: PluginUI = Object.freeze({
				...unsupportedPluginUI,
				...updateControls,
				select: (prompt, choices, options) => {
					if (choices.length === 0) {
						return Promise.resolve(undefined);
					}
					return request<string | undefined>(
						"select",
						prompt,
						{ choices },
						undefined,
						options
					);
				},
				confirm: (title, message, options) =>
					request<boolean>(
						"confirm",
						title,
						{ ...(message === undefined ? {} : { message }) },
						false,
						options
					),
				input: (title, placeholder, options) =>
					request<string | undefined>(
						"input",
						title,
						{ ...(placeholder === undefined ? {} : { placeholder }) },
						undefined,
						options
					),
				editor: (title, initialValue, options) =>
					request<string | undefined>(
						"editor",
						title,
						{ ...(initialValue === undefined ? {} : { initialValue }) },
						undefined,
						options
					),
				notify: (message, level = "info") => {
					if (closed || handleClosed) {
						return;
					}
					const notification = {
						level,
						message,
						pluginId: owner.pluginId,
					};
					if (isRpcPluginUINotification(notification)) {
						transport.notify(notification);
					}
				},
				custom: async () => undefined,
			});
			const handle: PluginUIHandle = Object.freeze({
				close() {
					if (handleClosed) {
						return;
					}
					handleClosed = true;
					controller.abort();
					handles.delete(handle);
				},
				ui,
			});
			handles.add(handle);
			return handle;
		},
		update(update) {
			publishUpdate(update);
		},
	});
};
