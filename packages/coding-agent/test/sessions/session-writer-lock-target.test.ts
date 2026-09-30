import { describe, expect, test } from "bun:test";
import {
	resolveSessionWriterLockAdapter,
	SessionWriterLockFailureError,
} from "@/modules/sessions/storage/session-writer-lock";

const supportedTargets = [
	{ arch: "x64", platform: "linux", primitive: "flock" },
	{ arch: "arm64", platform: "linux", primitive: "flock" },
	{ arch: "x64", platform: "darwin", primitive: "flock" },
	{ arch: "arm64", platform: "darwin", primitive: "flock" },
	{ arch: "x64", platform: "win32", primitive: "LockFileEx" },
] as const;

const unsupportedTargets = [
	{ arch: "arm64", platform: "win32" },
	{ arch: "arm", platform: "linux" },
	{ arch: "x64", platform: "plan9" },
	{ arch: "prototype", platform: "constructor" },
] as const;

describe("Session Writer lock target resolution", () => {
	for (const target of supportedTargets) {
		test(`selects ${target.primitive} for ${target.platform}/${target.arch}`, () => {
			expect(
				resolveSessionWriterLockAdapter(target.platform, target.arch).primitive
			).toBe(target.primitive);
		});
	}

	for (const target of unsupportedTargets) {
		test(`fails closed with a target diagnostic for ${target.platform}/${target.arch}`, () => {
			let failure: unknown;
			try {
				resolveSessionWriterLockAdapter(target.platform, target.arch);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(SessionWriterLockFailureError);
			if (!(failure instanceof SessionWriterLockFailureError)) {
				throw new Error("An unsupported lock target was not rejected.");
			}
			expect(failure.code).toBe("session_lock_failed");
			expect(failure.message).toContain(`${target.platform}/${target.arch}`);
		});
	}
});
