let cleanup: (() => Promise<void>) | undefined;

export const setInteractiveCleanup = (callback: () => Promise<void>): void => {
	cleanup = callback;
};

export const runInteractiveCleanup = async (): Promise<void> => {
	await cleanup?.();
};
