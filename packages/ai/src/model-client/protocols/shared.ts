import { ModelProviderError, providerEventError } from "../errors";
import type { ModelProtocol } from "./types";

export type JsonRecord = Record<string, unknown>;
export type SsePayload = Readonly<{ eventName?: string; value: JsonRecord }>;

export const record = (value: unknown): JsonRecord | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;

export const unknownArray = (value: unknown): readonly unknown[] | undefined =>
	Array.isArray(value) ? value : undefined;

export const base64 = (data: string | Uint8Array): string => {
	if (typeof data === "string") {
		const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
		return comma === -1 ? data : data.slice(comma + 1);
	}
	let binary = "";
	for (let offset = 0; offset < data.length; offset += 0x80_00) {
		binary += String.fromCharCode(...data.subarray(offset, offset + 0x80_00));
	}
	return btoa(binary);
};

export const fileDataUri = (
	mediaType: string,
	data: string | Uint8Array
): string =>
	typeof data === "string" && data.startsWith("data:")
		? data
		: `data:${mediaType};base64,${base64(data)}`;

export const valueAsText = (value: unknown): string =>
	typeof value === "string" ? value : (JSON.stringify(value) ?? "");

export const unreachableValue = (value: never): never => {
	throw new Error(`Unexpected value: ${String(value)}`);
};

export const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

export const parseJsonValue = (value: unknown): unknown => {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
};

export const payloadFrom = (
	data: string,
	eventName: string | undefined
): SsePayload | undefined => {
	try {
		const value = record(JSON.parse(data));
		return value ? { eventName, value } : undefined;
	} catch {
		return;
	}
};

export const providerError = (
	payload: SsePayload,
	response: Response
): ModelProviderError | undefined => {
	const root = payload.value;
	if (
		payload.eventName === "response.failed" ||
		root.type === "response.failed"
	) {
		const responseBody = record(root.response);
		const failure = responseBody?.error ?? root.error;
		return providerEventError(
			{ error: failure ?? { message: "The model response failed." } },
			"error",
			response
		);
	}
	return providerEventError(root, payload.eventName, response);
};

export const incompleteStreamError = (
	protocol: ModelProtocol
): ModelProviderError =>
	new ModelProviderError(`${protocol} model stream ended before completion.`);
