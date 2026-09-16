import type { UnknownRecord } from "type-fest";

export const isObjectLike = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null;

export const isPlainObject = (value: unknown): value is UnknownRecord => {
	if (!isObjectLike(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
};

export const isUndefined = (value: unknown): value is undefined =>
	value === undefined;

export const isNull = (value: unknown): value is null => value === null;

export const isError = (value: unknown): value is Error =>
	value instanceof Error;

export const isBoolean = (value: unknown): value is boolean =>
	typeof value === "boolean" || value instanceof Boolean;

export const isString = (value: unknown): value is string =>
	typeof value === "string";

export const isNumber = (value: unknown): value is number =>
	typeof value === "number";

export const isInteger = (value: unknown): value is number =>
	isNumber(value) && Number.isInteger(value);

export function isLength(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isArray<Value>(
	value: Value
): value is Value & readonly unknown[] {
	return Array.isArray(value);
}

export function isArrayLike(value: unknown): boolean {
	return (
		value != null &&
		typeof value !== "function" &&
		isLength((value as ArrayLike<unknown>).length)
	);
}

export const isNonEmptyString = (value: unknown): value is string =>
	isString(value) && value.length > 0;

export const isFiniteNonNegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

export const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

export const isPositiveInteger = (value: unknown): value is number =>
	isNonNegativeInteger(value) && value > 0;
