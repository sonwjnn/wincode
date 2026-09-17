import { isUndefined } from "./guards";

/**
 * Removes every own enumerable string key the predicate accepts, without
 * mutating the input.
 *
 * Shallow by design — nested values are left untouched. Symbol-keyed
 * properties are not copied because the filter walks string keys; call it with
 * the object literals it exists for. Native on purpose: `@wincode/runtime-utils`
 * stays a runtime-dependency-free leaf (ADR-0018).
 */
export const omitBy = <T extends Record<string, unknown>>(
	value: T,
	shouldOmit: (entry: T[keyof T], key: string) => boolean
): Partial<T> => {
	const kept: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const entry = value[key] as T[keyof T];
		if (!shouldOmit(entry, key)) {
			kept[key] = entry;
		}
	}
	return kept as Partial<T>;
};

/**
 * Keeps every own enumerable string key the predicate accepts, without
 * mutating the input.
 *
 * Same shallow, string-key-only contract as {@link omitBy}.
 */
export const pickBy = <T extends Record<string, unknown>>(
	value: T,
	shouldPick: (entry: T[keyof T], key: string) => boolean
): Partial<T> => {
	const picked: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const entry = value[key] as T[keyof T];
		if (shouldPick(entry, key)) {
			picked[key] = entry;
		}
	}
	return picked as Partial<T>;
};

/**
 * The shape {@link omitUndefined} returns: a key that can hold `undefined`
 * becomes optional, every other key keeps its required modifier.
 */
export type OmitUndefined<T> = Partial<T> & {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/** Drops every key whose value is `undefined`. */
export const omitUndefined = <T extends Record<string, unknown>>(
	value: T
): OmitUndefined<T> => omitBy(value, isUndefined) as OmitUndefined<T>;

/** Keeps every key whose value is truthy. */
export const pickTruthy = <T extends Record<string, unknown>>(
	value: T
): Partial<T> => pickBy(value, Boolean);
