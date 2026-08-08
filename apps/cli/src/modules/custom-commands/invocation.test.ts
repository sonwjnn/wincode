import { describe, expect, test } from "bun:test";
import { parseCustomCommandInvocation } from "./invocation";

describe("parseCustomCommandInvocation", () => {
	test("parses a bare invocation without arguments", () => {
		expect(parseCustomCommandInvocation("/git-commit")).toEqual({
			name: "git-commit",
			arguments: "",
		});
	});

	test("parses invocation with arguments", () => {
		expect(parseCustomCommandInvocation("/git-commit staged files")).toEqual({
			name: "git-commit",
			arguments: "staged files",
		});
	});

	test("rejects plain text and unknown names", () => {
		expect(parseCustomCommandInvocation("hello")).toBeNull();
		expect(parseCustomCommandInvocation("review the code")).toBeNull();
	});
});
