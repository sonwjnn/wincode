export type InteractiveRuntimeLifecycle = Readonly<{
	isCleanupRequested: () => boolean;
	runCleanup: () => Promise<void>;
	setCleanup: (callback: () => Promise<void>) => void;
	withRuntimeReplacement: <Result>(
		action: () => Promise<Result>
	) => Promise<Result>;
}>;

export const createInteractiveRuntimeLifecycle =
	(): InteractiveRuntimeLifecycle => {
		let cleanup: (() => Promise<void>) | undefined;
		let cleanupRequested = false;
		let cleanupPromise: Promise<void> | undefined;
		let activeRuntimeReplacement: Promise<void> | undefined;

		const withRuntimeReplacement: InteractiveRuntimeLifecycle["withRuntimeReplacement"] =
			async (action) => {
				if (cleanupRequested) {
					throw new Error("Interactive application cleanup has started.");
				}
				if (activeRuntimeReplacement !== undefined) {
					throw new Error(
						"An interactive runtime replacement is already in progress."
					);
				}
				const replacementFinished = Promise.withResolvers<void>();
				activeRuntimeReplacement = replacementFinished.promise;
				try {
					return await action();
				} finally {
					if (activeRuntimeReplacement === replacementFinished.promise) {
						activeRuntimeReplacement = undefined;
					}
					replacementFinished.resolve();
				}
			};
		const runCleanup: InteractiveRuntimeLifecycle["runCleanup"] = () => {
			if (cleanupPromise !== undefined) {
				return cleanupPromise;
			}
			cleanupRequested = true;
			const replacement = activeRuntimeReplacement;
			const closing = (async () => {
				await replacement;
				await cleanup?.();
			})();
			cleanupPromise = closing;
			return closing;
		};

		return Object.freeze({
			isCleanupRequested: () => cleanupRequested,
			runCleanup,
			setCleanup: (callback) => {
				cleanup = callback;
			},
			withRuntimeReplacement,
		});
	};

const applicationLifecycle = createInteractiveRuntimeLifecycle();

export const setInteractiveCleanup = applicationLifecycle.setCleanup;

export const isInteractiveCleanupRequested =
	applicationLifecycle.isCleanupRequested;

export const withInteractiveRuntimeReplacement =
	applicationLifecycle.withRuntimeReplacement;

export const runInteractiveCleanup = applicationLifecycle.runCleanup;
