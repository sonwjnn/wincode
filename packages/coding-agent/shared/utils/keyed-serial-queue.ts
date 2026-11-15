export type KeyedSerialQueue = Readonly<{
	run: <Result>(
		key: string,
		operation: () => Promise<Result>
	) => Promise<Result>;
}>;

export type KeyedSerialQueueRegistry = Readonly<{
	run: <Result>(
		registryKey: string,
		key: string,
		operation: () => Promise<Result>
	) => Promise<Result>;
}>;

export type KeyedSerialQueueOptions = Readonly<{
	onIdle?: () => void;
}>;

export type KeyedSerialQueueFactory = (onIdle: () => void) => KeyedSerialQueue;

/** Serializes asynchronous operations independently for each string key. */
export const createKeyedSerialQueue = (
	options: KeyedSerialQueueOptions = {}
): KeyedSerialQueue => {
	const tails = new Map<string, Promise<void>>();

	return {
		run: async <Result>(
			key: string,
			operation: () => Promise<Result>
		): Promise<Result> => {
			const previous = tails.get(key) ?? Promise.resolve();
			const current = previous.then(operation);
			const tail = current.then(
				() => undefined,
				() => undefined
			);
			tails.set(key, tail);
			try {
				return await current;
			} finally {
				if (tails.get(key) === tail) {
					tails.delete(key);
				}
				if (tails.size === 0) {
					options.onIdle?.();
				}
			}
		},
	};
};

/** Serializes root-scoped keyed work without retaining idle queues. */
export const createKeyedSerialQueueRegistry = (
	createQueue: KeyedSerialQueueFactory = (onIdle) =>
		createKeyedSerialQueue({ onIdle })
): KeyedSerialQueueRegistry => {
	const queues = new Map<string, KeyedSerialQueue>();

	return {
		run: <Result>(
			registryKey: string,
			key: string,
			operation: () => Promise<Result>
		): Promise<Result> => {
			let queue = queues.get(registryKey);
			if (queue === undefined) {
				const onIdle = (): void => {
					if (queues.get(registryKey) === queue) {
						queues.delete(registryKey);
					}
				};
				queue = createQueue(onIdle);
				queues.set(registryKey, queue);
			}
			return queue.run(key, operation);
		},
	};
};
