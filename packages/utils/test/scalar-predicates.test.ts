import { describe, expect, test } from "bun:test";
import {
	isArrayLike,
	isError,
	isFiniteNonNegativeNumber,
	isInteger,
	isLength,
	isNonEmptyString,
	isNonEmptyStringWithinUtf8ByteLimit,
	isNonNegativeInteger,
	isNumber,
	isObjectLike,
	isPlainObject,
	isPositiveInteger,
	isPositiveSafeInteger,
	isString,
	isUndefined,
} from "../src/index";

describe("runtime object predicates", () => {
	test("accepts objects and arrays but not null, primitives, or functions", () => {
		expect(isObjectLike({})).toBe(true);
		expect(isObjectLike([])).toBe(true);
		expect(isObjectLike(new Date(0))).toBe(true);
		expect(isObjectLike(null)).toBe(false);
		expect(isObjectLike(undefined)).toBe(false);
		expect(isObjectLike("text")).toBe(false);
		expect(isObjectLike(1)).toBe(false);
		expect(isObjectLike(() => undefined)).toBe(false);
	});

	test("accepts prototype-less and literal objects but not class instances or arrays", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject({ key: "value" })).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(new Date(0))).toBe(false);
		expect(
			isPlainObject(
				new (class Fixture {
					readonly key = "value";
				})()
			)
		).toBe(false);
	});
});

describe("runtime scalar predicates", () => {
	test("accepts Error instances without accepting error-shaped objects", () => {
		expect(isError(new Error("failure"))).toBe(true);
		expect(isError(new TypeError("failure"))).toBe(true);
		expect(isError({ name: "Error", message: "failure" })).toBe(false);
		expect(isError("failure")).toBe(false);
	});
	test("accepts non-empty strings without trimming", () => {
		expect(isNonEmptyString("text")).toBe(true);
		expect(isNonEmptyString(" ")).toBe(true);
		expect(isNonEmptyString("")).toBe(false);
		expect(isNonEmptyString(null)).toBe(false);
	});

	test("UTF-8 string limits count encoded bytes, not UTF-16 code units", () => {
		expect(isNonEmptyStringWithinUtf8ByteLimit("a", 1)).toBe(true);
		expect(isNonEmptyStringWithinUtf8ByteLimit("é", 2)).toBe(true);
		expect(isNonEmptyStringWithinUtf8ByteLimit("é", 1)).toBe(false);
		expect(isNonEmptyStringWithinUtf8ByteLimit("", 1)).toBe(false);
	});

	test("accepts strings including empty strings", () => {
		expect(isString("text")).toBe(true);
		expect(isString("")).toBe(true);
		expect(isString(" ")).toBe(true);
		expect(isString(null)).toBe(false);
		expect(isString(1)).toBe(false);
	});

	test("accepts any number including NaN, because it checks only the runtime type", () => {
		expect(isNumber(1)).toBe(true);
		expect(isNumber(Number.NaN)).toBe(true);
		expect(isNumber("1")).toBe(false);
		expect(isNumber(null)).toBe(false);
	});

	test("accepts integers beyond the safe range and rejects fractional values", () => {
		expect(isInteger(0)).toBe(true);
		expect(isInteger(-3)).toBe(true);
		expect(isInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(true);
		expect(isInteger(1.5)).toBe(false);
		expect(isInteger(Number.NaN)).toBe(false);
		expect(isInteger(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isInteger("1")).toBe(false);
	});

	test("accepts only non-negative safe integers as lengths", () => {
		expect(isLength(0)).toBe(true);
		expect(isLength(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isLength(-1)).toBe(false);
		expect(isLength(1.5)).toBe(false);
		expect(isLength(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
		expect(isLength("1")).toBe(false);
		expect(isLength(undefined)).toBe(false);
	});

	test("treats strings as array-like but excludes functions and negative lengths", () => {
		expect(isArrayLike([1, 2])).toBe(true);
		expect(isArrayLike("abc")).toBe(true);
		expect(isArrayLike({ length: 2 })).toBe(true);
		expect(isArrayLike({ length: -1 })).toBe(false);
		expect(isArrayLike(() => undefined)).toBe(false);
		expect(isArrayLike(null)).toBe(false);
		expect(isArrayLike(42)).toBe(false);
	});

	test("accepts only undefined values", () => {
		expect(isUndefined(undefined)).toBe(true);
		expect(isUndefined(null)).toBe(false);
		expect(isUndefined("")).toBe(false);
		expect(isUndefined(0)).toBe(false);
	});

	test("accepts finite non-negative numbers", () => {
		expect(isFiniteNonNegativeNumber(0)).toBe(true);
		expect(isFiniteNonNegativeNumber(1.5)).toBe(true);
		expect(isFiniteNonNegativeNumber(-0)).toBe(true);
		expect(isFiniteNonNegativeNumber(-1)).toBe(false);
		expect(isFiniteNonNegativeNumber(Number.NaN)).toBe(false);
		expect(isFiniteNonNegativeNumber(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isFiniteNonNegativeNumber("1")).toBe(false);
	});

	test("accepts non-negative integers including unsafe integers", () => {
		expect(isNonNegativeInteger(0)).toBe(true);
		expect(isNonNegativeInteger(42)).toBe(true);
		expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(true);
		expect(isNonNegativeInteger(1.5)).toBe(false);
		expect(isNonNegativeInteger(-1)).toBe(false);
		expect(isNonNegativeInteger(Number.NaN)).toBe(false);
	});

	test("accepts only positive integers", () => {
		expect(isPositiveInteger(1)).toBe(true);
		expect(isPositiveInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(true);
		expect(isPositiveInteger(0)).toBe(false);
		expect(isPositiveInteger(-1)).toBe(false);
		expect(isPositiveInteger(1.5)).toBe(false);
		expect(isPositiveInteger(Number.POSITIVE_INFINITY)).toBe(false);
	});

	test("accepts only positive safe integers", () => {
		expect(isPositiveSafeInteger(1)).toBe(true);
		expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
		expect(isPositiveSafeInteger(0)).toBe(false);
		expect(isPositiveSafeInteger(-1)).toBe(false);
		expect(isPositiveSafeInteger(1.5)).toBe(false);
		expect(isPositiveSafeInteger(Number.POSITIVE_INFINITY)).toBe(false);
	});
});
