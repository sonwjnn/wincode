export type SseEvent = Readonly<{ data: string; event?: string }>;

const eventFrom = (
	eventName: string | undefined,
	dataLines: readonly string[]
): SseEvent | undefined =>
	dataLines.length > 0
		? {
				data: dataLines.join("\n"),
				...(eventName ? { event: eventName } : {}),
			}
		: undefined;
const lineWithoutCarriageReturn = (line: string): string =>
	line.endsWith("\r") ? line.slice(0, -1) : line;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (!signal?.aborted) {
		return;
	}
	throw (
		signal.reason ??
		new DOMException("The operation was aborted.", "AbortError")
	);
};

const linesFromBuffer = (
	buffer: string
): { lines: string[]; remainder: string } => {
	const lines: string[] = [];
	let remainder = buffer;
	let newline = remainder.indexOf("\n");
	while (newline !== -1) {
		lines.push(lineWithoutCarriageReturn(remainder.slice(0, newline)));
		remainder = remainder.slice(newline + 1);
		newline = remainder.indexOf("\n");
	}
	return { lines, remainder };
};

export async function* readSseEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal
): AsyncIterable<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | undefined;
	let dataLines: string[] = [];
	let completed = false;

	const cancelPendingRead = (): void => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	signal?.addEventListener("abort", cancelPendingRead, { once: true });
	if (signal?.aborted) {
		cancelPendingRead();
	}

	const dispatch = (): SseEvent | undefined => {
		const event = eventFrom(eventName, dataLines);
		eventName = undefined;
		dataLines = [];
		return event;
	};

	const processLine = (line: string): SseEvent | undefined => {
		if (line === "") {
			return dispatch();
		}
		if (line.startsWith(":")) {
			return;
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		if (field === "event") {
			eventName = value;
		} else if (field === "data") {
			dataLines.push(value);
		}
		return;
	};

	try {
		while (true) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			throwIfAborted(signal);
			if (done) {
				completed = true;
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsedLines = linesFromBuffer(buffer);
			buffer = parsedLines.remainder;
			for (const line of parsedLines.lines) {
				const event = processLine(line);
				if (event?.data === "[DONE]") {
					yield event;
					return;
				}
				if (event) {
					yield event;
				}
			}
		}

		buffer += decoder.decode();
		const trailingEvent = processLine(lineWithoutCarriageReturn(buffer));
		if (trailingEvent?.data === "[DONE]") {
			yield trailingEvent;
			return;
		}
		if (trailingEvent) {
			yield trailingEvent;
		}
		const event = dispatch();
		if (event?.data === "[DONE]") {
			yield event;
			return;
		}
		if (event) {
			yield event;
		}
	} finally {
		signal?.removeEventListener("abort", cancelPendingRead);
		if (!completed) {
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}
}
