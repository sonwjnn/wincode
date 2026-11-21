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

/** Updates a visible countdown from its deadline without owning request settlement. */
export const schedulePluginUITitleCountdown = (
	deadline: number,
	onTick: (remainingSeconds: number) => void,
	isActive: () => boolean
): (() => void) => {
	let cancelCurrent: (() => void) | undefined;
	let cancelled = false;
	const schedule = (): void => {
		if (cancelled || !isActive()) {
			return;
		}
		const now = performance.now();
		const remainingMs = Math.max(0, deadline - now);
		const remainingSeconds = Math.ceil(remainingMs / 1000);
		if (remainingSeconds <= 1 || remainingSeconds - 1 === remainingSeconds) {
			return;
		}
		const nextChangeAt = deadline - (remainingSeconds - 1) * 1000;
		cancelCurrent = schedulePluginUITimeout(
			Math.max(1, nextChangeAt - now),
			() => {
				cancelCurrent = undefined;
				if (cancelled || !isActive()) {
					return;
				}
				onTick(Math.ceil(Math.max(0, deadline - performance.now()) / 1000));
				schedule();
			}
		);
	};
	schedule();
	return () => {
		cancelled = true;
		cancelCurrent?.();
	};
};
