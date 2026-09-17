import { expect, test } from "bun:test";
import { parseCompactCommand } from "@/modules/sessions/compaction/commands";

test("parses exact compact commands and public focus text", () => {
	expect(parseCompactCommand("/compact")).toEqual({});
	expect(parseCompactCommand("  /compact preserve the API decision  ")).toEqual(
		{
			focus: "preserve the API decision",
		}
	);
	expect(parseCompactCommand("/compactible")).toBeNull();
});
