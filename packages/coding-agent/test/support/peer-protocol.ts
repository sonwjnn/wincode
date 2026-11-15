/** Persistent newline-delimited reader used by the peer-process protocol. */
type LineReader = Readonly<{
	close: () => void;
	next: () => Promise<string>;
}>;

export const createLineReader = (
	stream: ReadableStream<Uint8Array>
): LineReader => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	return {
		close: () => {
			reader.releaseLock();
		},
		next: async () => {
			for (;;) {
				const newline = text.indexOf("\n");
				if (newline >= 0) {
					const line = text.slice(0, newline);
					text = text.slice(newline + 1);
					return line;
				}
				const { done, value } = await reader.read();
				if (done) {
					throw new Error("The peer process exited before reporting.");
				}
				text += decoder.decode(value, { stream: true });
			}
		},
	};
};
