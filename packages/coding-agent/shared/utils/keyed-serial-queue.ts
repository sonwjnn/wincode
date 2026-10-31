/** Serializes asynchronous operations independently for each string key. */
export const createKeyedSerialQueue = () => {
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
			}
		},
	};
};
