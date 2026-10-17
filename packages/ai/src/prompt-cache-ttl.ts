const PROMPT_CACHE_TTL_PATTERN = /^(\d+)(s|m|h)$/u;

/** Parses a source-declared cache lifetime without guessing unsupported units. */
export const parsePromptCacheTtlMs = (value: string): number | undefined => {
	const parsed = PROMPT_CACHE_TTL_PATTERN.exec(value);
	if (parsed === null) {
		return;
	}
	const amount = Number(parsed[1]);
	let unitMs: number;
	switch (parsed[2]) {
		case "s":
			unitMs = 1000;
			break;
		case "m":
			unitMs = 60_000;
			break;
		case "h":
			unitMs = 60 * 60_000;
			break;
		default:
			return;
	}
	const durationMs = amount * unitMs;
	return Number.isSafeInteger(durationMs) && durationMs > 0
		? durationMs
		: undefined;
};
