const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TIMER_DELAY_BIGINT = BigInt(MAX_TIMER_DELAY_MS);

type PluginUITimeoutChunk = Readonly<{
	delayMs: number;
	remainingMs: bigint;
}>;

export const nextPluginUITimeoutChunk = (
	remainingMs: bigint
): PluginUITimeoutChunk => {
	const delay =
		remainingMs > MAX_TIMER_DELAY_BIGINT ? MAX_TIMER_DELAY_BIGINT : remainingMs;
	return {
		delayMs: Number(delay),
		remainingMs: remainingMs - delay,
	};
};

/** Schedules a validated timeout and returns the function that cancels it. */
export const schedulePluginUITimeout = (
	timeoutMs: number,
	onExpire: () => void
): (() => void) => {
	if (timeoutMs <= MAX_TIMER_DELAY_MS) {
		const timer = setTimeout(onExpire, timeoutMs);
		return () => clearTimeout(timer);
	}

	// A very large number can lose precision when subtracting a timer chunk.
	let remainingMs = BigInt(Math.ceil(timeoutMs));
	const scheduleChunk = (): NodeJS.Timeout => {
		const chunk = nextPluginUITimeoutChunk(remainingMs);
		return setTimeout(() => {
			remainingMs = chunk.remainingMs;
			if (remainingMs === 0n) {
				onExpire();
			} else {
				timer = scheduleChunk();
			}
		}, chunk.delayMs);
	};
	let timer = scheduleChunk();
	return () => clearTimeout(timer);
};
