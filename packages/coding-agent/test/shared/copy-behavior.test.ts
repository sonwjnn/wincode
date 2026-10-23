import { expect, test } from "bun:test";
import { resolveDefaultCopyBehavior } from "@/shared/clipboard/copy-behavior";

test("Copy behavior defaults to manual on Windows and select elsewhere", () => {
	expect(resolveDefaultCopyBehavior("win32")).toBe("manual");
	expect(resolveDefaultCopyBehavior("darwin")).toBe("select");
	expect(resolveDefaultCopyBehavior("linux")).toBe("select");
});
