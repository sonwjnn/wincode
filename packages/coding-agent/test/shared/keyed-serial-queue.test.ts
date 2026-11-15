import { expect, test } from "bun:test";
import {
	createKeyedSerialQueue,
	createKeyedSerialQueueRegistry,
	type KeyedSerialQueue,
	type KeyedSerialQueueRegistry,
} from "@/shared/utils/keyed-serial-queue";

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

test("an idle root recreates its queue without splitting same-key operations", async () => {
	let queuesCreated = 0;
	const registry = createKeyedSerialQueueRegistry((onIdle) => {
		queuesCreated += 1;
		return createKeyedSerialQueue({ onIdle });
	});
	const order: string[] = [];
	await registry.run("canonical-root", "session-a", async () => {
		order.push("idle-round");
	});

	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const first = registry.run("canonical-root", "session-a", async () => {
		order.push("first-start");
		firstStarted.resolve();
		await releaseFirst.promise;
		order.push("first-end");
	});
	await firstStarted.promise;
	const second = registry.run("canonical-root", "session-a", async () => {
		order.push("second");
	});

	expect(queuesCreated).toBe(2);
	expect(order).toEqual(["idle-round", "first-start"]);
	releaseFirst.resolve();
	await Promise.all([first, second]);
	expect(order).toEqual(["idle-round", "first-start", "first-end", "second"]);
});

const exerciseActiveRootWork = async (
	registry: KeyedSerialQueueRegistry,
	queueReferences: readonly WeakRef<KeyedSerialQueue>[]
): Promise<void> => {
	const releaseFirst = Promise.withResolvers<void>();
	const releaseSecond = Promise.withResolvers<void>();
	const first = registry.run("canonical-root", "session-a", async () => {
		await releaseFirst.promise;
		return "first";
	});
	const second = registry.run("canonical-root", "session-b", async () => {
		await releaseSecond.promise;
		throw new Error("operation failed");
	});

	expect(queueReferences).toHaveLength(1);
	expect(queueReferences[0]?.deref()).toBeDefined();
	releaseFirst.resolve();
	expect(await first).toBe("first");
	expect(queueReferences[0]?.deref()).toBeDefined();
	releaseSecond.resolve();
	await expect(second).rejects.toThrow("operation failed");
};

const yieldToNextEventLoopTurn = async (): Promise<void> => {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
};

const exerciseIdleRoots = async (
	registry: KeyedSerialQueueRegistry
): Promise<void> => {
	for (let index = 0; index < 32; index += 1) {
		await registry.run(
			`canonical-root-${index}`,
			"session-a",
			async () => index
		);
	}
};

test("the root registry retains a queue through active work, then releases it even after rejection", async () => {
	const queueReferences: WeakRef<KeyedSerialQueue>[] = [];
	const registry = createKeyedSerialQueueRegistry((onIdle) => {
		const queue = createKeyedSerialQueue({ onIdle });
		queueReferences.push(new WeakRef(queue));
		return queue;
	});
	await exerciseActiveRootWork(registry, queueReferences);
	await exerciseIdleRoots(registry);

	for (let attempt = 0; attempt < 10; attempt += 1) {
		Bun.gc(true);
		await yieldToNextEventLoopTurn();
		if (queueReferences.every((reference) => reference.deref() === undefined)) {
			break;
		}
	}
	expect(queueReferences).toHaveLength(33);
	const retainedQueueIndexes = queueReferences.flatMap((reference, index) =>
		reference.deref() === undefined ? [] : [index]
	);
	expect(retainedQueueIndexes).toEqual([]);
	expect(queueReferences.map((reference) => reference.deref())).toEqual(
		Array.from({ length: 33 }, () => undefined)
	);
});
