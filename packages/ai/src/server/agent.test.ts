import { describe, expect, it } from "bun:test";
import {
	getSafePositiveMaxSteps,
	invokeCodingAgentLifecycleCallback,
} from "./agent";

describe("invokeCodingAgentLifecycleCallback", () => {
	it("swallows callback errors", async () => {
		let called = false;

		await invokeCodingAgentLifecycleCallback(async () => {
			called = true;
			throw new Error("boom");
		}, undefined);

		expect(called).toBe(true);
	});

	it("runs callback once", async () => {
		let count = 0;

		await invokeCodingAgentLifecycleCallback(() => {
			count += 1;
		}, undefined);

		expect(count).toBe(1);
	});

	it("clamps max steps to safe positive value", () => {
		expect(getSafePositiveMaxSteps(undefined)).toBe(1);
		expect(getSafePositiveMaxSteps(0)).toBe(1);
		expect(getSafePositiveMaxSteps(3)).toBe(3);
	});
});
