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
