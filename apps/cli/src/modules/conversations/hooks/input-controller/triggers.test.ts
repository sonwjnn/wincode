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

	test("detects file mention through mention grammar", () => {
		expect(detectTrigger("see @packages/foo now", 17)).toEqual({
			end: 17,
			kind: "file-mention",
			query: "packages/foo",
			start: 4,
		});
		expect(detectTrigger("hello foo@bar.com", 17)).toBeNull();
		expect(detectTrigger('"@packages/foo"', 14)).toBeNull();
	});
});
