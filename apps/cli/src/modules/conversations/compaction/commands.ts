const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+([\s\S]*?))?$/u;

export type CompactCommand = {
	focus?: string;
};

export const parseCompactCommand = (text: string): CompactCommand | null => {
	const match = COMPACT_COMMAND_PATTERN.exec(text.trim());
	if (!match) {
		return null;
	}
	const focus = match[1]?.trim();
	return focus ? { focus } : {};
};

export const isCompactionSettingsCommand = (text: string): boolean =>
	text.trim() === "/compaction";

export const isSettingsCommand = (text: string): boolean =>
	text.trim() === "/settings";
