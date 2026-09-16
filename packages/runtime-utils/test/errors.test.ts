import { describe, expect, test } from "bun:test";
import { getErrorMessage } from "../src/index";

describe("runtime error utilities", () => {
	test("returns an Error message when available", () => {
		expect(getErrorMessage(new Error("failure"), "fallback")).toBe("failure");
	});

	test("returns the explicit fallback for non-Errors", () => {
		expect(getErrorMessage({ message: "failure" }, "fallback")).toBe(
			"fallback"
		);
		expect(getErrorMessage("failure", "fallback")).toBe("fallback");
	});

	test("returns an Error's message even when it is empty", () => {
		const error = new Error("temporary");
		error.message = "";
		expect(getErrorMessage(error, "fallback")).toBe("");
	});
});
