import { isObjectLike } from "@wincode/utils";
import type { UnknownRecord } from "type-fest";

export class ProviderProtocolError extends Error {
	readonly cacheControlRejected: boolean;
	readonly providerCode: string | undefined;
	readonly retryAfterMs: number | undefined;
	readonly statusCode: number | undefined;

	constructor(
		message: string,
		metadata: {
			cacheControlRejected?: boolean;
			providerCode?: string;
			retryAfterMs?: number;
			statusCode?: number;
		} = {}
	) {
		super(message);
		this.name = "ProviderProtocolError";
		this.cacheControlRejected = metadata.cacheControlRejected ?? false;
		this.providerCode = metadata.providerCode;
		this.retryAfterMs = metadata.retryAfterMs;
		this.statusCode = metadata.statusCode;
	}
}

const CACHE_CONTROL_TERMS =
	/\b(cache[_ -]control|cached[_ -]?content|cache resource|prompt[_ -]cache(?:[_ -](?:key|options|breakpoint|retention))?|prompt caching|cache breakpoints?|cache ttl|cache retention|cache duration)\b/iu;

const record = (value: unknown): UnknownRecord | undefined =>
	isObjectLike(value) ? value : undefined;

const numericStatus = (value: unknown): number | undefined =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= 100 &&
	value <= 599
		? value
		: undefined;

const retryAfterMsFromValue = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.ceil(value * 1000);
	}
	if (typeof value !== "string" || value.length === 0) {
		return;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.ceil(seconds * 1000);
	}
	const date = Date.parse(value);
	return Number.isFinite(date) && date > Date.now()
		? date - Date.now()
		: undefined;
};

export const retryAfterMsFromHeader = (
	value: string | null
): number | undefined => retryAfterMsFromValue(value ?? undefined);

const errorMessage = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	const object = record(value);
	return typeof object?.message === "string" && object.message.trim().length > 0
		? object.message
		: undefined;
};

const statusFromErrorPayload = (payload: unknown): number | undefined => {
	const root = record(payload);
	const response = record(root?.response);
	const error = record(root?.error) ?? record(response?.error);
	const errorStatus = numericStatus(
		error?.status_code ?? error?.status ?? error?.code
	);
	if (errorStatus) {
		return errorStatus;
	}
	const status = numericStatus(
		root?.status_code ??
			root?.status ??
			response?.status_code ??
			response?.status ??
			root?.code
	);
	if (status) {
		return status;
	}
	const classification = [root?.type, error?.type, error?.code]
		.filter((part): part is string => typeof part === "string")
		.join(" ")
		.toLowerCase();
	if (
		classification.includes("rate_limit") ||
		classification.includes("too_many")
	) {
		return 429;
	}
	if (
		classification.includes("authentication") ||
		classification.includes("unauthorized")
	) {
		return 401;
	}
	if (
		classification.includes("permission") ||
		classification.includes("forbidden")
	) {
		return 403;
	}
	if (
		classification.includes("model_not_found") ||
		classification.includes("not_found")
	) {
		return 404;
	}
	if (
		classification.includes("invalid_request") ||
		classification.includes("bad_request")
	) {
		return 400;
	}
};

const messageFromPayload = (payload: unknown): string | undefined => {
	const root = record(payload);
	const response = record(root?.response);
	return (
		errorMessage(root?.error) ??
		errorMessage(response?.error) ??
		errorMessage(root?.message) ??
		errorMessage(payload)
	);
};

const providerCodeFromPayload = (payload: unknown): string | undefined => {
	const root = record(payload);
	const response = record(root?.response);
	const error = record(root?.error) ?? record(response?.error);
	return [
		error?.code,
		error?.type,
		root?.type,
		root?.code,
		response?.code,
	].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0
	);
};

export const isCacheControlRejectionDetails = (
	message: string,
	statusCode: number | undefined,
	classification = ""
): boolean => {
	const namesCacheControl = CACHE_CONTROL_TERMS.test(
		`${classification} ${message}`
	);
	const isCacheRejection =
		statusCode === 400 ||
		statusCode === 404 ||
		statusCode === 422 ||
		classification.includes("invalid_request");
	return namesCacheControl && isCacheRejection;
};

const isCacheControlRejectionPayload = (
	payload: unknown,
	statusCode: number | undefined
): boolean => {
	const root = record(payload);
	const response = record(root?.response);
	const error = record(root?.error) ?? record(response?.error);
	const classification = [root?.type, error?.type, error?.code]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
	const message = messageFromPayload(payload) ?? "";
	return isCacheControlRejectionDetails(message, statusCode, classification);
};

export const isCacheControlRejection = (
	error: unknown
): error is ProviderProtocolError =>
	error instanceof ProviderProtocolError && error.cacheControlRejected;

export const httpErrorFromPayload = (
	statusCode: number,
	headers: Readonly<{ get: (name: string) => string | null }>,
	payload: unknown,
	fallbackBody = ""
): ProviderProtocolError => {
	const message =
		messageFromPayload(payload) ?? fallbackBody.trim().slice(0, 512);
	return new ProviderProtocolError(
		message.length > 0
			? `Model provider request failed (${statusCode}): ${message}`
			: `Model provider request failed (${statusCode}).`,
		{
			cacheControlRejected: isCacheControlRejectionPayload(payload, statusCode),
			providerCode: providerCodeFromPayload(payload),
			retryAfterMs: retryAfterMsFromHeader(headers.get("retry-after")),
			statusCode,
		}
	);
};

export const httpErrorFromResponse = async (
	response: Response
): Promise<ProviderProtocolError> => {
	const body = await response.text().catch(() => "");
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		payload = undefined;
	}
	return httpErrorFromPayload(response.status, response.headers, payload, body);
};

const retryAfterMsFromPayload = (
	error: Record<string, unknown> | undefined,
	root: Record<string, unknown> | undefined
): number | undefined => {
	const response = record(root?.response);
	const milliseconds =
		error?.retry_after_ms ?? root?.retry_after_ms ?? response?.retry_after_ms;
	if (
		typeof milliseconds === "number" &&
		Number.isFinite(milliseconds) &&
		milliseconds > 0
	) {
		return Math.ceil(milliseconds);
	}
	if (typeof milliseconds === "string") {
		const parsedMilliseconds = Number(milliseconds);
		if (Number.isFinite(parsedMilliseconds) && parsedMilliseconds > 0) {
			return Math.ceil(parsedMilliseconds);
		}
	}
	return retryAfterMsFromValue(
		error?.retry_after ?? root?.retry_after ?? response?.retry_after
	);
};

export const providerEventError = (
	payload: unknown,
	eventName: string | undefined,
	response: Response
): ProviderProtocolError | undefined => {
	const root = record(payload);
	const responsePayload = record(root?.response);
	const error = record(root?.error) ?? record(responsePayload?.error);
	const type = root?.type;
	const failedEvent =
		(typeof type === "string" && type.endsWith(".failed")) ||
		(typeof eventName === "string" && eventName.endsWith(".failed"));
	if (
		!(
			eventName === "error" ||
			error !== undefined ||
			type === "error" ||
			failedEvent ||
			responsePayload?.status === "failed"
		)
	) {
		return;
	}
	const statusCode =
		statusFromErrorPayload(payload) ??
		numericStatus(response.status === 200 ? undefined : response.status);
	const retryAfterMs =
		retryAfterMsFromPayload(record(error), root) ??
		retryAfterMsFromHeader(response.headers.get("retry-after"));
	const message =
		messageFromPayload(payload) ??
		"The model provider reported a stream error.";
	return new ProviderProtocolError(
		statusCode
			? `Model provider stream failed (${statusCode}): ${message}`
			: message,
		{
			cacheControlRejected: isCacheControlRejectionPayload(payload, statusCode),
			providerCode: providerCodeFromPayload(payload),
			retryAfterMs,
			statusCode,
		}
	);
};
