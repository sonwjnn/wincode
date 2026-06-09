import { describe, expect, test } from "bun:test";
import { detectCommandTrigger, detectTrigger } from "./triggers";

describe("chat input controller triggers", () => {
	test("detects slash command query", () => {
		expect(detectCommandTrigger("/")).toEqual({
			kind: "command",
			query: "",
		});
		expect(detectCommandTrigger("/models")).toEqual({
			kind: "command",
			query: "models",
		});
	});

	test("ignores non-command and spaced command text", () => {
		expect(detectCommandTrigger("hello")).toBeNull();
		expect(detectCommandTrigger("/new session")).toBeNull();
	});

	test("detects active trigger with command priority", () => {
		expect(detectTrigger("/theme", 6)).toEqual({
			kind: "command",
			query: "theme",
		});
		expect(detectTrigger("hello", 5)).toBeNull();
	});
});
