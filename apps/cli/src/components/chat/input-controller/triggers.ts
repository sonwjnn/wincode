export type CommandTrigger = {
	kind: "command";
	query: string;
};

export type ActiveTrigger = CommandTrigger;

export const detectCommandTrigger = (text: string): CommandTrigger | null => {
	if (!text.startsWith("/")) {
		return null;
	}

	const query = text.slice(1);

	if (query.includes(" ")) {
		return null;
	}

	return { kind: "command", query };
};

export const detectTrigger = (
	text: string,
	_cursorOffset: number
): ActiveTrigger | null => detectCommandTrigger(text);
