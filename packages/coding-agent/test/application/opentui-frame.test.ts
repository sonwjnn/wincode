import { expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { waitForTestFrame } from "../support/opentui";

test("frame assertions survive a transient native OutputBusy lease without accepting an empty frame", async () => {
	let captures = 0;
	const setup = fromPartial<TestRendererSetup>({
		captureCharFrame: () => {
			captures += 1;
			if (captures === 1) {
				throw new Error("ot_session_acquire_buffer_lease failed: OutputBusy");
			}
			return "This project is not trusted.";
		},
	});
	expect(await waitForTestFrame(setup)).toBe("This project is not trusted.");
	expect(captures).toBe(2);
});

test("frame capture does not hide non-busy native errors", async () => {
	const error = new Error(
		"ot_session_acquire_buffer_lease failed: InvalidSession"
	);
	const setup = fromPartial<TestRendererSetup>({
		captureCharFrame: () => {
			throw error;
		},
	});
	await expect(waitForTestFrame(setup)).rejects.toBe(error);
});

test("a permanently busy frame fails instead of passing a missing UI assertion", async () => {
	const setup = fromPartial<TestRendererSetup>({
		captureCharFrame: () => {
			throw new Error("ot_session_acquire_buffer_lease failed: OutputBusy");
		},
	});
	await expect(waitForTestFrame(setup)).rejects.toThrow("remained busy");
});
