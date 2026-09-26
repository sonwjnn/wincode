import { describe, expect, test } from "bun:test";
import { fuzzyRank } from "@/shared/fuzzy";

describe("fuzzyRank", () => {
	test("ranks tighter subsequences ahead of a start-position bonus", () => {
		const ranked = fuzzyRank(["axyd", "zaxd"], "ad", (text) => text);

		expect(ranked.map(({ item }) => item)).toEqual(["zaxd", "axyd"]);
	});
});
