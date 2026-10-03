import {
	isError,
	isObjectLike,
	isString,
	type LogFields,
} from "@wincode/runtime-utils";

export const getErrorCode = (error: unknown): string | undefined =>
	isObjectLike(error) && "code" in error && isString(error.code)
		? error.code
		: undefined;

export const errorLogFields = (error: unknown): LogFields => {
	const errorCode = getErrorCode(error);
	return {
		errorType: isError(error) ? error.name : typeof error,
		...(errorCode === undefined ? {} : { errorCode }),
	};
};

/** Human-readable reason for an escaped value, when one exists. */
export const describeReason = (error: unknown): string | undefined => {
	if (isError(error)) {
		return error.message;
	}
	if (isString(error)) {
		return error;
	}
	if (isObjectLike(error) && "message" in error && isString(error.message)) {
		return error.message;
	}
	return;
};

/** Diagnostics for an escaping error: structured type/code plus message and stack. */
export const errorDiagnosticFields = (error: unknown): LogFields => {
	const message = describeReason(error);
	return {
		...errorLogFields(error),
		...(message === undefined ? {} : { errorMessage: message }),
		...(isError(error) && error.stack !== undefined
			? { stack: error.stack }
			: {}),
	};
};
