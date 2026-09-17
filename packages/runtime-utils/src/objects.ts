import { isUndefined } from "./guards";

/**
 * The shape {@link omitUndefined} returns: a key that can hold `undefined`
 * becomes optional, every other key keeps its required modifier.
 */
export type OmitUndefined<T> = Partial<T> & {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Removes every own enumerable string key whose value is `undefined`, without
 * mutating the input.
 *
 * Shallow by design — nested values are left untouched. Symbol-keyed
 * properties are not copied because the filter walks string keys; call it with
 * the object literals it exists for. Native on purpose: `@wincode/runtime-utils`
 * stays a runtime-dependency-free leaf (ADR-0018).
 */
export const omitUndefined = <T extends Record<string, unknown>>(
	value: T
): OmitUndefined<T> => {
	const defined: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const entry = value[key];
		if (!isUndefined(entry)) {
			defined[key] = entry;
		}
	}
	return defined as OmitUndefined<T>;
};
