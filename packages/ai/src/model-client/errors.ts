export class ModelProviderError extends Error {
	readonly retryAfterMs: number | undefined;
	readonly statusCode: number | undefined;

	constructor(
		message: string,
		metadata: { retryAfterMs?: number; statusCode?: number } = {}
	) {
		super(message);
		this.name = "ModelProviderError";
		this.retryAfterMs = metadata.retryAfterMs;
		this.statusCode = metadata.statusCode;
	}
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;

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

export const httpErrorFromResponse = async (
	response: Response
): Promise<ModelProviderError> => {
	const body = await response.text().catch(() => "");
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		payload = undefined;
	}
	const message = messageFromPayload(payload) ?? body.trim().slice(0, 512);
	return new ModelProviderError(
		message.length > 0
			? `Model provider request failed (${response.status}): ${message}`
			: `Model provider request failed (${response.status}).`,
		{
			retryAfterMs: retryAfterMsFromHeader(response.headers.get("retry-after")),
			statusCode: response.status,
		}
	);
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
): ModelProviderError | undefined => {
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
	return new ModelProviderError(
		statusCode
			? `Model provider stream failed (${statusCode}): ${message}`
			: message,
		{ retryAfterMs, statusCode }
	);
};
