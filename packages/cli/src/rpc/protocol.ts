import { isPlainObject } from "@wincode/runtime-utils";

export const JSON_RPC_VERSION = "2.0" as const;
export const MAX_JSONL_RECORD_BYTES = 16 * 1024 * 1024;

export const RPC_ERROR_CODES = {
	internal: -32_603,
	invalidParams: -32_602,
	invalidRequest: -32_600,
	methodNotFound: -32_601,
	parseError: -32_700,
} as const;

export type RpcErrorCode =
	(typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];
export type RpcId = string;
export type RpcParams = Record<string, unknown>;
export type RpcRequest = Readonly<{
	id: RpcId;
	jsonrpc: typeof JSON_RPC_VERSION;
	method: string;
	params?: RpcParams;
}>;
export type RpcError = Readonly<{
	code: number;
	data?: unknown;
	message: string;
}>;
export type RpcResponse = Readonly<
	| { id: RpcId; jsonrpc: typeof JSON_RPC_VERSION; result: unknown }
	| { error: RpcError; id: RpcId | null; jsonrpc: typeof JSON_RPC_VERSION }
>;
export type JsonlInput =
	| AsyncIterable<Uint8Array<ArrayBufferLike>>
	| Iterable<Uint8Array<ArrayBufferLike>>;
export type JsonlRecord =
	| { kind: "frame"; raw: string; value: unknown }
	| { fatal?: true; kind: "error"; message: string };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const decodeJsonlLine = (line: Uint8Array<ArrayBufferLike>): JsonlRecord => {
	if (line.length > MAX_JSONL_RECORD_BYTES) {
		return { kind: "error", message: "JSONL frame exceeds the size limit." };
	}
	let raw: string;
	try {
		raw = utf8Decoder.decode(line);
	} catch {
		return {
			fatal: true,
			kind: "error",
			message: "Frame is not valid UTF-8.",
		};
	}
	if (raw.endsWith("\r") || raw.length === 0) {
		return {
			kind: "error",
			message: "Frame must be one non-empty LF-delimited JSON value.",
		};
	}
	try {
		return { kind: "frame", raw, value: JSON.parse(raw) as unknown };
	} catch {
		return { kind: "error", message: "Frame is not valid JSON." };
	}
};

/** Splits a byte stream only on LF and never treats a partial UTF-8 codepoint as a frame. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The parser owns byte buffering, UTF-8 fatality, LF recovery, and abort teardown in one state machine.
export const readJsonl = async function* (
	input: JsonlInput,
	signal?: AbortSignal
): AsyncGenerator<JsonlRecord> {
	let pending = new Uint8Array(0) as Uint8Array<ArrayBufferLike>;
	let pendingLength = 0;
	let discardingOversized = false;
	const append = (chunk: Uint8Array<ArrayBufferLike>): void => {
		if (chunk.length === 0) {
			return;
		}
		const required = pendingLength + chunk.length;
		if (required > pending.length) {
			let capacity = Math.max(1024, pending.length);
			while (capacity < required) {
				capacity *= 2;
			}
			const next = new Uint8Array(capacity) as Uint8Array<ArrayBufferLike>;
			next.set(pending.subarray(0, pendingLength));
			pending = next;
		}
		pending.set(chunk, pendingLength);
		pendingLength = required;
	};
	const iterator: AsyncIterator<Uint8Array<ArrayBufferLike>> =
		Symbol.asyncIterator in input
			? input[Symbol.asyncIterator]()
			: (async function* (): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
					for (const chunk of input) {
						yield chunk;
					}
				})();
	const aborted = Promise.withResolvers<void>();
	const onAbort = (): void => {
		aborted.resolve();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted === true) {
		aborted.resolve();
	}
	try {
		while (true) {
			const next =
				signal === undefined
					? await iterator.next()
					: await Promise.race([
							iterator.next(),
							aborted.promise.then(() => null),
						]);
			if (next === null || next.done) {
				break;
			}
			let available = next.value;
			if (discardingOversized) {
				const newline = available.indexOf(10);
				if (newline < 0) {
					continue;
				}
				available = available.subarray(newline + 1);
				discardingOversized = false;
			}
			append(available);
			let lineStart = 0;
			let cursor = 0;
			while (cursor < pendingLength) {
				const newline = pending.subarray(cursor, pendingLength).indexOf(10);
				if (newline < 0) {
					break;
				}
				const lineEnd = cursor + newline;
				yield decodeJsonlLine(pending.subarray(lineStart, lineEnd));
				lineStart = lineEnd + 1;
				cursor = lineStart;
			}
			if (lineStart > 0) {
				pending.copyWithin(0, lineStart, pendingLength);
				pendingLength -= lineStart;
			}
			if (pendingLength > MAX_JSONL_RECORD_BYTES) {
				yield { kind: "error", message: "JSONL frame exceeds the size limit." };
				pending = new Uint8Array(0) as Uint8Array<ArrayBufferLike>;
				pendingLength = 0;
				discardingOversized = true;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (signal?.aborted === true) {
			void iterator.return?.()?.catch(() => undefined);
		}
	}
	if (signal?.aborted !== true && pendingLength > 0 && !discardingOversized) {
		try {
			utf8Decoder.decode(pending.subarray(0, pendingLength));
		} catch {
			yield {
				fatal: true,
				kind: "error",
				message: "Frame is not valid UTF-8.",
			};
			return;
		}
		yield {
			kind: "error",
			message: "Input ended before an LF-delimited frame completed.",
		};
	}
};

export const parseRpcRequest = (
	value: unknown
): { request?: RpcRequest; error?: RpcError } => {
	if (!isPlainObject(value)) {
		return {
			error: {
				code: RPC_ERROR_CODES.invalidRequest,
				message: "Invalid Request",
			},
		};
	}
	if (
		value.jsonrpc !== JSON_RPC_VERSION ||
		typeof value.id !== "string" ||
		value.id.length === 0
	) {
		return {
			error: {
				code: RPC_ERROR_CODES.invalidRequest,
				message: "Invalid Request",
			},
		};
	}
	if (typeof value.method !== "string" || value.method.length === 0) {
		return {
			error: {
				code: RPC_ERROR_CODES.invalidRequest,
				message: "Invalid Request",
			},
		};
	}
	if (value.params !== undefined && !isPlainObject(value.params)) {
		return {
			error: {
				code: RPC_ERROR_CODES.invalidRequest,
				message: "Invalid Request",
			},
		};
	}
	return {
		request: {
			id: value.id,
			jsonrpc: JSON_RPC_VERSION,
			method: value.method,
			...(value.params === undefined ? {} : { params: value.params }),
		},
	};
};

export const success = (id: RpcId, result: unknown): RpcResponse => ({
	id,
	jsonrpc: JSON_RPC_VERSION,
	result,
});

export const failure = (
	id: RpcId | null,
	code: number,
	message: string,
	data?: unknown
): RpcResponse => ({
	error: {
		code,
		message,
		...(data === undefined ? {} : { data }),
	},
	id,
	jsonrpc: JSON_RPC_VERSION,
});
