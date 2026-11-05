import { expect, test } from "bun:test";
import { createKeyedSerialQueue } from "@/shared/utils/keyed-serial-queue";

test("same-key operations wait their turn without blocking independent keys", async () => {
	const queue = createKeyedSerialQueue();
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const order: string[] = [];
	const first = queue.run("session-a", async () => {
		order.push("first-start");
		firstStarted.resolve();
		await releaseFirst.promise;
		order.push("first-end");
		return "first";
	});
	await firstStarted.promise;
	const second = queue.run("session-a", async () => {
		order.push("second");
		return "second";
	});
	const independent = queue.run("session-b", async () => {
		order.push("independent");
		return "independent";
	});

	expect(await independent).toBe("independent");
	expect(order).toEqual(["first-start", "independent"]);
	releaseFirst.resolve();
	expect(await first).toBe("first");
	expect(await second).toBe("second");
	expect(order).toEqual(["first-start", "independent", "first-end", "second"]);
});
