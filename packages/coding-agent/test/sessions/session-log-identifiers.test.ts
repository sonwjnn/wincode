import { expect, test } from "bun:test";
import { isValidSessionLogIdentifier } from "@/modules/sessions/session-log-identifiers";

test("shared Session log identifier validation rejects path separators and overlong IDs", () => {
	expect(isValidSessionLogIdentifier("valid.fork-operation_1")).toBe(true);
	expect(isValidSessionLogIdentifier("../outside-session-log")).toBe(false);
	expect(isValidSessionLogIdentifier("a".repeat(513))).toBe(false);
	expect(isValidSessionLogIdentifier("valid-operation\n")).toBe(false);
});
