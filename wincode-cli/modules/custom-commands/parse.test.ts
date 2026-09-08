import { describe, expect, test } from "bun:test";
import { CustomCommandValidationError, parseCustomCommandFile } from "./parse";

describe("parseCustomCommandFile", () => {
	test("parses description and template body", () => {
		expect(
			parseCustomCommandFile(
				"---\ndescription: Run tests with coverage\n---\nRun the full test suite.\nFocus on failures."
			)
		).toEqual({
			description: "Run tests with coverage",
			template: "Run the full test suite.\nFocus on failures.",
		});
	});

	test("defaults description to an empty string when missing", () => {
		expect(parseCustomCommandFile("---\n---\nDo the thing")).toEqual({
			description: "",
			template: "Do the thing",
		});
	});

	test("accepts a file without frontmatter as a bare template", () => {
		expect(parseCustomCommandFile("Just a prompt.")).toEqual({
			description: "",
			template: "Just a prompt.",
		});
	});

	test("ignores unknown frontmatter fields", () => {
		expect(
			parseCustomCommandFile(
				"---\ndescription: Analyze code\nagent: build\nmodel: x/y\n---\nAnalyze it."
			)
		).toEqual({
			description: "Analyze code",
			template: "Analyze it.",
		});
	});

	test("trims surrounding whitespace from the template body", () => {
		expect(parseCustomCommandFile("---\n---\n  Padded prompt.  \n")).toEqual({
			description: "",
			template: "Padded prompt.",
		});
	});

	test("rejects a file with broken frontmatter delimiters", () => {
		expect(() => parseCustomCommandFile("---\ndescription: broken")).toThrow(
			CustomCommandValidationError
		);
	});

	test("supports quoted description values", () => {
		expect(
			parseCustomCommandFile('---\ndescription: "Quoted value"\n---\nX')
		).toEqual({
			description: "Quoted value",
			template: "X",
		});
	});
});
