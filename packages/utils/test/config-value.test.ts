import { expect, test } from "bun:test";
import { resolveConfigEnvironmentVariables } from "../src/config-value.ts";

test("dollar-prefixed environment references expand while escapes stay literal", () => {
	expect(
		resolveConfigEnvironmentVariables(
			["Bearer $", "{TOKEN}:$TOKEN:$env:TOKEN:$$literal:$!literal"].join(""),
			{ TOKEN: "secret" }
		)
	).toEqual({
		value: "Bearer secret:secret:secret:$literal:!literal",
	});
});

test("missing environment references fail without returning a partially expanded secret", () => {
	expect(
		resolveConfigEnvironmentVariables("prefix-$MISSING-suffix", {})
	).toEqual({ missingVariable: "MISSING" });
});
