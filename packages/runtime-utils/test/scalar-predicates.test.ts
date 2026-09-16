import { describe, expect, test } from "bun:test";
import {
	isError,
	isFiniteNonNegativeNumber,
	isNonEmptyString,
	isNonNegativeInteger,
	isPositiveInteger,
	isString,
	isUndefined,
} from "../src/index";

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

	test("accepts strings including empty strings", () => {
		expect(isString("text")).toBe(true);
		expect(isString("")).toBe(true);
		expect(isString(" ")).toBe(true);
		expect(isString(null)).toBe(false);
		expect(isString(1)).toBe(false);
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
});
