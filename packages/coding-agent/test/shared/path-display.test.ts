import { expect, test } from "bun:test";
import { shortenHomePath } from "@/shared/paths/display-path";

test("shortens home paths without rewriting sibling path prefixes", () => {
	const home = "/Users/example";

	expect(shortenHomePath(home, home)).toBe("~");
	expect(shortenHomePath(`${home}/workspace`, home)).toBe("~/workspace");
	expect(shortenHomePath(`${home}\\workspace`, home)).toBe("~\\workspace");
	expect(shortenHomePath(`${home}-backup/workspace`, home)).toBe(
		`${home}-backup/workspace`
	);
	expect(shortenHomePath("/workspace/repo", home)).toBe("/workspace/repo");
});
