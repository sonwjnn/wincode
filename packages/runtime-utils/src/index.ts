import type { UnknownRecord } from "type-fest";

const OBJECT_TAG = "[object Object]";
const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);

/** Narrows an unknown value to a non-null object, including arrays. */
export const isObjectLike = (value: unknown): value is UnknownRecord =>
	typeof value === "object" && value !== null;

/** Narrows an unknown value to a plain object with no custom class prototype. */
export const isPlainObject = (value: unknown): value is UnknownRecord => {
	if (
		!isObjectLike(value) ||
		Object.prototype.toString.call(value) !== OBJECT_TAG
	) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null) {
		return true;
	}
	const prototypeConstructor = Object.hasOwn(prototype, "constructor")
		? prototype.constructor
		: undefined;
	return (
		typeof prototypeConstructor === "function" &&
		prototypeConstructor instanceof prototypeConstructor &&
		Function.prototype.toString.call(prototypeConstructor) ===
			OBJECT_CONSTRUCTOR_SOURCE
	);
};
/** Narrows an unknown value to a non-empty string without trimming it. */
export const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

/** Narrows an unknown value to a finite number greater than or equal to zero. */
export const isFiniteNonNegativeNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Narrows an unknown value to an integer greater than or equal to zero. */
export const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Narrows an unknown value to a positive integer. */
export const isPositiveInteger = (value: unknown): value is number =>
	isNonNegativeInteger(value) && value > 0;
