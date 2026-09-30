export type PastedText = { token: string; text: string };

export const normalizePastedText = (text: string): string =>
	text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

export const summarizePastedText = (value: string): PastedText | undefined => {
	const text = normalizePastedText(value);
	const trimmed = text.trim();
	if (trimmed.split("\n").length < 3 && trimmed.length <= 150) {
		return;
	}
	return { text, token: `[Pasted ~${trimmed.split("\n").length} lines]` };
};
