let cleanup: (() => Promise<void>) | undefined;

export const setTuiCleanup = (callback: () => Promise<void>): void => {
	cleanup = callback;
};

export const runTuiCleanup = async (): Promise<void> => {
	await cleanup?.();
};
