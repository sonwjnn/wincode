import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "type-fest";
import { isJsonObject, isJsonValue } from "../src/index";

describe("runtime JSON predicates", () => {
	test("accepts JSON primitives and nested plain data", () => {
		const nullPrototype = Object.create(null) as JsonObject;
		nullPrototype.value = 1;
		const schema = {
			properties: { name: { type: "string" } },
			type: "object",
		} as const satisfies JsonObject;
		const readonlyValue = {
			items: [null, false, 1, "text"],
			nested: nullPrototype,
		} as const satisfies JsonValue;

		expect(isJsonValue(null)).toBe(true);
		expect(isJsonValue(readonlyValue)).toBe(true);
		expect(isJsonObject(schema)).toBe(true);
		expect(isJsonObject(nullPrototype)).toBe(true);
	});

	test("rejects values that cannot be represented by JSON", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(isJsonValue(undefined)).toBe(false);
		expect(isJsonValue(1n)).toBe(false);
		expect(isJsonValue(Symbol("value"))).toBe(false);
		expect(isJsonValue(Number.NaN)).toBe(false);
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isJsonValue(new Date())).toBe(false);
		expect(isJsonValue(new Map())).toBe(false);
		expect(isJsonValue(new (class CustomValue {})())).toBe(false);
		expect(isJsonValue(cyclic)).toBe(false);
	});

	test("requires an object root and enforces an optional depth limit", () => {
		let nested: unknown = "leaf";
		for (let index = 0; index < 3; index += 1) {
			nested = { child: nested };
		}

		expect(isJsonObject([])).toBe(false);
		expect(isJsonObject("object")).toBe(false);
		expect(isJsonObject(null)).toBe(false);
		expect(isJsonValue(nested)).toBe(true);
		expect(isJsonValue(nested, { maxDepth: 2 })).toBe(false);
		expect(isJsonValue(nested, { maxDepth: 3 })).toBe(true);
	});
});
