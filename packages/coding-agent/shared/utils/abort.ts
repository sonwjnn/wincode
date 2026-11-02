type AbortReasonFactory = (
	signal: AbortSignal,
	fallbackMessage: string
) => unknown;

export const isAborted = (signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true;

export const getAbortReason = (
	signal: AbortSignal,
	fallbackMessage = "Aborted"
): unknown => signal.reason ?? new DOMException(fallbackMessage, "AbortError");

export const getAbortError = (
	signal: AbortSignal,
	fallbackMessage = "Aborted"
): Error =>
	signal.reason instanceof Error
		? signal.reason
		: new DOMException(fallbackMessage, "AbortError");

export const throwIfAborted = (
	signal: AbortSignal | undefined,
	fallbackMessage = "Aborted",
	createAbortReason: AbortReasonFactory = getAbortReason
): void => {
	if (signal?.aborted !== true) {
		return;
	}
	throw createAbortReason(signal, fallbackMessage);
};
