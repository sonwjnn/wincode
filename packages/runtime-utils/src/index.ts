import type { JsonObject, JsonValue, UnknownRecord } from "type-fest";

/** Options for validating JSON-compatible runtime values. */
export type JsonValueValidationOptions = Readonly<{
	maxDepth?: number;
}>;

/** Narrows an unknown value to a non-null object, including arrays. */
export const isObjectLike = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null;

/** Narrows an unknown value to a plain object with no custom class prototype. */
export const isPlainObject = (value: unknown): value is UnknownRecord => {
	if (!isObjectLike(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
};

const isJsonPrimitive = (
	value: unknown
): value is null | boolean | number | string =>
	value === null ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value)) ||
	typeof value === "string";

type PendingJsonValue = {
	depth: number;
	value: unknown;
};

const hasValidMaxDepth = (maxDepth: number): boolean =>
	maxDepth === Number.POSITIVE_INFINITY ||
	(Number.isInteger(maxDepth) && maxDepth >= 0);

const enqueueJsonChildren = (
	value: UnknownRecord,
	depth: number,
	pending: PendingJsonValue[]
): boolean => {
	if (Array.isArray(value)) {
		for (const item of value) {
			pending.push({ depth, value: item });
		}
		return true;
	}
	if (!isPlainObject(value)) {
		return false;
	}
	for (const nestedValue of Object.values(value)) {
		pending.push({ depth, value: nestedValue });
	}
	return true;
};

/**
 * Narrows an unknown value to a JSON-compatible value.
 *
 * Objects must have Object.prototype or a null prototype. Repeated object
 * references and cyclic values are rejected because JSON values are trees.
 * The default depth is unbounded; callers handling untrusted data should set
 * maxDepth.
 */
export const isJsonValue = (
	value: unknown,
	options: JsonValueValidationOptions = {}
): value is JsonValue => {
	const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
	if (!hasValidMaxDepth(maxDepth)) {
		return false;
	}

	try {
		const pending: PendingJsonValue[] = [{ depth: 0, value }];
		const seen = new WeakSet<object>();

		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || current.depth > maxDepth) {
				return false;
			}
			if (isJsonPrimitive(current.value)) {
				continue;
			}
			if (!isObjectLike(current.value) || seen.has(current.value)) {
				return false;
			}
			seen.add(current.value);
			if (!enqueueJsonChildren(current.value, current.depth + 1, pending)) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
};

/** Narrows an unknown value to a JSON-compatible object. */
export const isJsonObject = (
	value: unknown,
	options: JsonValueValidationOptions = {}
): value is JsonObject => {
	try {
		return isPlainObject(value) && isJsonValue(value, options);
	} catch {
		return false;
	}
};

/** Narrows an unknown value to undefined. */
export const isUndefined = (value: unknown): value is undefined =>
	value === undefined;

/** Narrows an unknown value to a string, including empty strings. */
export const isString = (value: unknown): value is string =>
	typeof value === "string";

/** Narrows an unknown value to a non-empty string without trimming it. */
export const isNonEmptyString = (value: unknown): value is string =>
	isString(value) && value.length > 0;

/** Narrows an unknown value to a finite number greater than or equal to zero. */
export const isFiniteNonNegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Narrows an unknown value to an integer greater than or equal to zero. */
export const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Narrows an unknown value to a positive integer. */
export const isPositiveInteger = (value: unknown): value is number =>
	isNonNegativeInteger(value) && value > 0;
