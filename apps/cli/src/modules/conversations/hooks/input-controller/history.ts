export const shouldRecordCtrlC = (text: string): boolean =>
	text.trim().length >= 20;

export const prependPrompt = (entries: string[], prompt: string): string[] =>
	entries[0] === prompt ? entries : [prompt, ...entries].slice(0, 50);

export const resetHistoryNavigation = (
	text: string
): Pick<HistoryState, "draft" | "index"> => ({
	draft: text,
	index: -1,
});

export type HistoryState = { entries: string[]; index: number; draft: string };

export const navigateHistory = (
	state: HistoryState,
	direction: "up" | "down"
): { state: HistoryState; text: string; consumed: boolean } => {
	const next =
		direction === "up"
			? Math.min(state.entries.length - 1, state.index + 1)
			: Math.max(-1, state.index - 1);
	if (next === state.index) {
		return {
			consumed: false,
			state,
			text: state.index < 0 ? state.draft : (state.entries[state.index] ?? ""),
		};
	}
	const nextState = { ...state, index: next };
	return {
		consumed: true,
		state: nextState,
		text: next < 0 ? state.draft : (state.entries[next] ?? ""),
	};
};

export const decideDownAction = (
	cursor: number,
	textLength: number
): "moveToEnd" | "navigate" | "native" => {
	if (cursor < textLength) {
		return "moveToEnd";
	}
	if (cursor === textLength) {
		return "navigate";
	}
	return "native";
};

export const decideUpAction = (cursor: number): "moveToStart" | "navigate" =>
	cursor > 0 ? "moveToStart" : "navigate";
