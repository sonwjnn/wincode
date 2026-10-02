import { describe, expect, test } from "bun:test";
import {
	detectCommandTrigger,
	detectTrigger,
} from "@/modules/sessions/hooks/input-controller/triggers";

describe("chat input controller triggers", () => {
	test("detects the root command query at the start of the prompt", () => {
		expect(detectCommandTrigger("/")).toEqual({
			end: 1,
			kind: "command",
			mode: "root",
			query: "",
			start: 0,
		});
		expect(detectCommandTrigger("/models")).toEqual({
			end: 7,
			kind: "command",
			mode: "root",
			query: "models",
			start: 0,
		});
	});

	test("detects a leading slash after optional whitespace", () => {
		expect(detectTrigger(" /", 2)).toEqual({
			end: 2,
			kind: "command",
			mode: "root",
			query: "",
			start: 0,
		});
		expect(detectTrigger("  /ski", 6)).toEqual({
			end: 6,
			kind: "command",
			mode: "root",
			query: "ski",
			start: 0,
		});
	});

	test("detects a skill token after prose without consuming the prompt", () => {
		expect(detectCommandTrigger("rewrite this /rev", 17)).toEqual({
			end: 17,
			kind: "command",
			mode: "skill",
			query: "rev",
			start: 13,
		});
		expect(detectCommandTrigger("rewrite this /review and more", 20)).toEqual({
			end: 20,
			kind: "command",
			mode: "skill",
			query: "review",
			start: 13,
		});
	});

	test("ignores tokens that are not standalone command slashes", () => {
		expect(detectCommandTrigger("hello")).toBeNull();
		expect(detectCommandTrigger("/new session")).toBeNull();
		expect(detectCommandTrigger("see https://example.com", 23)).toBeNull();
		expect(detectCommandTrigger("see src/foo", 11)).toBeNull();
		expect(detectCommandTrigger("look at @src/file", 16)).toBeNull();
	});

	test("detects active trigger with command priority", () => {
		expect(detectTrigger("/themes", 7)).toEqual({
			end: 7,
			kind: "command",
			mode: "root",
			query: "themes",
			start: 0,
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
