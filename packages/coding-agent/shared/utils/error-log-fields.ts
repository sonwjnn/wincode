import {
	isError,
	isObjectLike,
	isString,
	type LogFields,
} from "@wincode/runtime-utils";

export const errorLogFields = (error: unknown): LogFields => {
	const errorCode =
		isObjectLike(error) && "code" in error && isString(error.code)
			? error.code
			: undefined;
	return {
		errorType: isError(error) ? error.name : typeof error,
		...(errorCode === undefined ? {} : { errorCode }),
	};
};
