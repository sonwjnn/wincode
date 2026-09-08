import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "./cli-options";

describe("parseCliOptions", () => {
	test("auto approval is off by default", () => {
		expect(parseCliOptions([]).autoApproval).toBe(false);
		expect(parseCliOptions(["node", "cli"]).autoApproval).toBe(false);
	});

	test("enables auto approval with --auto", () => {
		expect(parseCliOptions(["node", "cli", "--auto"]).autoApproval).toBe(true);
	});
});
