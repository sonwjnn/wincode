import { describe, expect, test } from "bun:test";
import { isObjectLike, isPlainObject } from "../src/index";

describe("runtime object predicates", () => {
	test("accepts plain data objects only", () => {
		const nullPrototype = Object.create(null);
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject(nullPrototype)).toBe(true);
		expect(isPlainObject(Object.create(nullPrototype))).toBe(false);
		expect(isPlainObject(Object.create({ inherited: true }))).toBe(false);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(new Date())).toBe(false);
		expect(isPlainObject(new Map())).toBe(false);
		expect(isPlainObject(new (class CustomObject {})())).toBe(false);
	});

	test("accepts non-null object-like values including arrays", () => {
		expect(isObjectLike({})).toBe(true);
		expect(isObjectLike([])).toBe(true);
		expect(isObjectLike(new Date())).toBe(true);
		expect(isObjectLike(null)).toBe(false);
		expect(isObjectLike(undefined)).toBe(false);
		expect(isObjectLike(() => undefined)).toBe(false);
		expect(isObjectLike("object")).toBe(false);
	});
});
