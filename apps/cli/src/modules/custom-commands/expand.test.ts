import { describe, expect, test } from "bun:test";
import { expandCustomCommandTemplate, extractArguments } from "./expand";

describe("extractArguments", () => {
	test("returns an empty string when the query has no arguments", () => {
		expect(extractArguments("test")).toBe("");
	});

	test("returns the text after the command name", () => {
		expect(extractArguments("test Button")).toBe("Button");
	});

	test("preserves internal spacing and trims edges", () => {
		expect(extractArguments("test  a   b ")).toBe("a   b");
	});
});

describe("expandCustomCommandTemplate", () => {
	test("substitutes all arguments into $ARGUMENTS", () => {
		expect(
			expandCustomCommandTemplate(
				"Create a React component named $ARGUMENTS",
				"Button"
			)
		).toBe("Create a React component named Button");
	});

	test("substitutes each occurrence of $ARGUMENTS", () => {
		expect(
			expandCustomCommandTemplate("$ARGUMENTS and again $ARGUMENTS", "x y")
		).toBe("x y and again x y");
	});

	test("replaces $ARGUMENTS with an empty string when no arguments are given", () => {
		expect(expandCustomCommandTemplate("Run $ARGUMENTS", "")).toBe("Run ");
	});

	test("substitutes positional arguments split on whitespace", () => {
		expect(
			expandCustomCommandTemplate(
				"Create $1 in the directory $2 with content $3",
				'config.json src "{}"'
			)
		).toBe('Create config.json in the directory src with content "{}"');
	});

	test("replaces missing positional arguments with an empty string", () => {
		expect(expandCustomCommandTemplate("$1 and $2", "only")).toBe("only and ");
	});

	test("leaves unknown dollar tokens untouched", () => {
		expect(expandCustomCommandTemplate("Costs $FOO", "x")).toBe("Costs $FOO");
	});

	test("supports $$ as a literal dollar escape", () => {
		expect(expandCustomCommandTemplate("Price is $$5", "")).toBe("Price is $5");
	});

	test("does not expand dollar tokens inside substituted arguments", () => {
		expect(expandCustomCommandTemplate("Value: $ARGUMENTS", "costs $5")).toBe(
			"Value: costs $5"
		);
	});
});
