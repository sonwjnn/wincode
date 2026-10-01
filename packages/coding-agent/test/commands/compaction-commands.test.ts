import { expect, test } from "bun:test";
import { findBuiltinCommand } from "@/modules/commands/builtin-invocation";

test("optional text commands preserve arguments without consuming other command names", () => {
	expect(findBuiltinCommand("/compact")).toMatchObject({
		action: "session.compact",
	});
	expect(
		findBuiltinCommand("  /compact preserve the API decision  ")
	).toMatchObject({
		action: "session.compact",
		argument: "preserve the API decision",
	});
	expect(findBuiltinCommand("/compactible")).toBeNull();
});
