import { expect, test } from "bun:test";
import { jsonContainerEnd } from "../src/index";

test("JSON container scan ignores braces in escaped strings", () => {
	const source = String.raw`{"text":"not the end } ] and an escaped \" quote","nested":[{"done":true}]} suffix`;

	expect(jsonContainerEnd(source, 0)).toBe(source.indexOf(" suffix"));
	expect(jsonContainerEnd('{"text":"unterminated }', 0)).toBe(-1);
});
