import type { JsonObject, JsonValue, UnknownRecord } from "type-fest";
import {
	isArray,
	isBoolean,
	isNull,
	isObjectLike,
	isPlainObject,
	isString,
} from "./guards";

export { getErrorMessage } from "./errors";
export * from "./guards";

export type JsonValueValidationOptions = Readonly<{
	maxDepth?: number;
}>;

const isJsonPrimitive = (
	value: unknown
): value is null | boolean | number | string =>
	isNull(value) ||
	isBoolean(value) ||
	(typeof value === "number" && Number.isFinite(value)) ||
	isString(value);

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
	if (isArray(value)) {
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
