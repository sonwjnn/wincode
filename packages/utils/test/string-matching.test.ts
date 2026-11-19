import { expect, test } from "bun:test";
import { findSubsequenceMatch, scoreSubsequenceMatch } from "../src/index";

test("subsequence matching reports the starting position and skipped characters", () => {
	expect(findSubsequenceMatch("abcdef", "bde")).toEqual({
		gaps: 1,
		start: 1,
	});
	expect(findSubsequenceMatch("abcdef", "bfz")).toBeNull();
});

test("scored subsequences prefer contiguous matches and retain span", () => {
	const contiguous = scoreSubsequenceMatch("abcdef", "bcd");
	const spread = scoreSubsequenceMatch("a_b_c_d", "bcd");

	expect(contiguous).not.toBeNull();
	expect(spread).not.toBeNull();
	expect(contiguous?.gaps).toBe(0);
	expect(contiguous?.span).toBe(3);
	expect(contiguous?.score).toBeLessThan(
		spread?.score ?? Number.POSITIVE_INFINITY
	);
	expect(scoreSubsequenceMatch("abcdef", "bgz")).toBeNull();
});
