import { logger } from "@wincode/utils";
import { schedulePluginUITimeout } from "../../plugins/ui/plugin-ui-timeout";
import {
	isRpcPluginUINotification,
	isRpcPluginUIRequest,
	isRpcPluginUIUpdate,
	type RPC_PLUGIN_UI_METHODS,
	type RpcPluginUINotification,
	type RpcPluginUIRequest,
	type RpcPluginUIRequestTransport,
	type RpcPluginUIUpdate,
	type RpcPluginUIWireResult,
} from "./plugin-ui";

type PendingPluginUIRequest = {
	defaultValue: RpcPluginUIWireResult;
	kind: RpcPluginUIRequest["kind"];
	pluginId: string;
	choices?: readonly string[];
	resolve: (value: RpcPluginUIWireResult) => void;
	signal?: AbortSignal;
	cancelTimeout?: () => void;
	onAbort: () => void;
};

export type RpcPluginUIChannel = Readonly<{
	transport: RpcPluginUIRequestTransport;
	receiveResponse: (
		id: string,
		result: unknown,
		isError: boolean,
		isValidFrame: boolean
	) => boolean;
	cancelRequest: (id: string) => boolean;
	close: () => void;
}>;

export type RpcPluginUIChannelOptions = Readonly<{
	sendCancellation: (id: string) => void;
	sendNotification: (
		method: (typeof RPC_PLUGIN_UI_METHODS)[number],
		params: RpcPluginUINotification | RpcPluginUIUpdate
	) => void;
	sendRequest: (id: string, params: RpcPluginUIRequest) => void;
}>;

const defaultValueFor = (
	kind: RpcPluginUIRequest["kind"]
): RpcPluginUIWireResult => (kind === "confirm" ? false : null);

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true;

const validResult = (
	request: PendingPluginUIRequest,
	result: unknown
): result is RpcPluginUIWireResult => {
	if (request.kind === "confirm") {
		return typeof result === "boolean";
	}
	if (request.kind === "select") {
		return (
			result === null ||
			(typeof result === "string" && request.choices?.includes(result) === true)
		);
	}
	return typeof result === "string" || result === null;
};

/** Correlates server-initiated UI requests with only their matching client reply. */
export const createRpcPluginUIChannel = (
	options: RpcPluginUIChannelOptions
): RpcPluginUIChannel => {
	const pending = new Map<string, PendingPluginUIRequest>();
	let closed = false;

	const finish = (
		id: string,
		request: PendingPluginUIRequest,
		value: RpcPluginUIWireResult,
		sendCancellation: boolean
	): void => {
		if (pending.get(id) !== request) {
			return;
		}
		pending.delete(id);
		request.cancelTimeout?.();
		request.signal?.removeEventListener("abort", request.onAbort);
		if (sendCancellation) {
			try {
				options.sendCancellation(id);
			} catch (error) {
				void logger.warn("RPC Plugin UI cancellation could not be sent", {
					cause: error instanceof Error ? error.message : String(error),
					operation: "rpc.plugin-ui.cancel",
				});
			}
		}
		request.resolve(value);
	};

	const requestUI = (
		requestValue: RpcPluginUIRequest,
		signal?: AbortSignal
	): Promise<RpcPluginUIWireResult> => {
		const defaultValue = defaultValueFor(requestValue.kind);
		if (
			closed ||
			signalIsAborted(signal) ||
			requestValue.timeoutMs === 0 ||
			!isRpcPluginUIRequest(requestValue)
		) {
			return Promise.resolve(defaultValue);
		}
		const deferred = Promise.withResolvers<RpcPluginUIWireResult>();
		let id = "";
		do {
			id = `plugin-ui:${crypto.randomUUID()}`;
		} while (pending.has(id));
		const onAbort = (): void => {
			const active = pending.get(id);
			if (active !== undefined) {
				finish(id, active, defaultValue, true);
			}
		};
		const active: PendingPluginUIRequest = {
			defaultValue,
			kind: requestValue.kind,
			pluginId: requestValue.pluginId,
			...(requestValue.kind === "select"
				? { choices: requestValue.choices }
				: {}),
			onAbort,
			resolve: deferred.resolve,
			...(signal === undefined ? {} : { signal }),
		};
		pending.set(id, active);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signalIsAborted(signal)) {
			onAbort();
			return deferred.promise;
		}
		if (requestValue.timeoutMs !== undefined) {
			active.cancelTimeout = schedulePluginUITimeout(
				Math.ceil(requestValue.timeoutMs),
				() => finish(id, active, defaultValue, true)
			);
		}
		try {
			options.sendRequest(id, requestValue);
		} catch (error) {
			void logger.warn("RPC Plugin UI request could not be sent", {
				cause: error instanceof Error ? error.message : String(error),
				operation: "rpc.plugin-ui.request",
				pluginId: requestValue.pluginId,
			});
			finish(id, active, defaultValue, false);
		}
		return deferred.promise;
	};

	const notify = (notification: RpcPluginUINotification): void => {
		if (closed || !isRpcPluginUINotification(notification)) {
			return;
		}
		try {
			options.sendNotification("plugin/ui/notify", notification);
		} catch (error) {
			void logger.warn("RPC Plugin UI notification could not be sent", {
				cause: error instanceof Error ? error.message : String(error),
				operation: "rpc.plugin-ui.notify",
				pluginId: notification.pluginId,
			});
		}
	};

	const update = (data: RpcPluginUIUpdate): void => {
		if (closed || !isRpcPluginUIUpdate(data)) {
			return;
		}
		try {
			options.sendNotification("plugin/ui/update", data);
		} catch (error) {
			void logger.warn("RPC Plugin UI update could not be sent", {
				cause: error instanceof Error ? error.message : String(error),
				operation: "rpc.plugin-ui.update",
				pluginId: data.pluginId,
			});
		}
	};

	return Object.freeze({
		transport: Object.freeze({ request: requestUI, notify, update }),
		receiveResponse(id, result, isError, isValidFrame) {
			const request = pending.get(id);
			if (request === undefined) {
				return false;
			}
			const valid = isValidFrame && !isError && validResult(request, result);
			if (!valid) {
				void logger.debug(
					"Invalid RPC Plugin UI response settled to its default",
					{
						operation: "rpc.plugin-ui.response",
						pluginId: request.pluginId,
						requestId: id,
					}
				);
				finish(id, request, request.defaultValue, false);
				return true;
			}
			finish(id, request, result, false);
			return true;
		},
		cancelRequest(id) {
			const request = pending.get(id);
			if (request === undefined) {
				return false;
			}
			finish(id, request, request.defaultValue, false);
			return true;
		},
		close() {
			if (closed) {
				return;
			}
			closed = true;
			for (const [id, request] of pending) {
				finish(id, request, request.defaultValue, false);
			}
		},
	});
};
