import type { CodingAgentUIMessage } from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";
import type { PromptHistoryEntry } from "../../storage/conversation-store";

export type { PromptHistoryEntry } from "../../storage/conversation-store";

const empty = (): PromptHistoryEntry => ({ text: "", files: [] });
const sameFiles = (a: PromptHistoryEntry, b: PromptHistoryEntry): boolean =>
	a.files.length === b.files.length &&
	a.files.every(
		(file, index) =>
			file.url === b.files[index]?.url &&
			file.mediaType === b.files[index]?.mediaType &&
			file.filename === b.files[index]?.filename
	);
const same = (a: PromptHistoryEntry, b: PromptHistoryEntry): boolean =>
	a.text === b.text &&
	JSON.stringify(a.fileTokens ?? []) === JSON.stringify(b.fileTokens ?? []) &&
	JSON.stringify(a.pastedText ?? []) === JSON.stringify(b.pastedText ?? []) &&
	sameFiles(a, b);
const expandedText = (entry: PromptHistoryEntry): string =>
	(entry.pastedText ?? []).reduce(
		(text, pasted) => text.replace(pasted.token, pasted.text),
		entry.text
	);

export const derivePromptHistory = (
	messages: CodingAgentUIMessage[]
): PromptHistoryEntry[] => {
	const entries: PromptHistoryEntry[] = [];

	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}

		const text = message.parts
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (!text) {
			continue;
		}

		const persistedFiles = message.parts.filter(
			(part): part is FileUIPart =>
				part.type === "file" && part.mediaType.startsWith("image/")
		);
		entries.unshift({ files: persistedFiles, text });
	}

	return entries.slice(0, 50);
};
export const mergePromptHistory = (
	sessionEntries: PromptHistoryEntry[],
	globalEntries: PromptHistoryEntry[]
): PromptHistoryEntry[] => {
	const unmatchedGlobalEntries = [...globalEntries];
	const enrichedSessionEntries = sessionEntries.map((sessionEntry) => {
		let matchingIndex = unmatchedGlobalEntries.findIndex(
			(globalEntry) =>
				(globalEntry.text === sessionEntry.text ||
					expandedText(globalEntry) === sessionEntry.text) &&
				sameFiles(globalEntry, sessionEntry)
		);
		if (matchingIndex === -1 && sessionEntry.files.length > 0) {
			matchingIndex = unmatchedGlobalEntries.findIndex(
				(globalEntry) =>
					(globalEntry.text === sessionEntry.text ||
						expandedText(globalEntry) === sessionEntry.text) &&
					globalEntry.files.length === 0
			);
		}
		if (matchingIndex === -1) {
			return sessionEntry;
		}

		const [matchingGlobalEntry] = unmatchedGlobalEntries.splice(
			matchingIndex,
			1
		);
		if (!(matchingGlobalEntry?.fileTokens || matchingGlobalEntry?.pastedText)) {
			return sessionEntry;
		}
		return {
			...sessionEntry,
			fileTokens: matchingGlobalEntry.fileTokens,
			pastedText: matchingGlobalEntry.pastedText,
			text: matchingGlobalEntry.pastedText
				? matchingGlobalEntry.text
				: sessionEntry.text,
		};
	});

	return [...enrichedSessionEntries, ...unmatchedGlobalEntries].slice(0, 50);
};
export const shouldRecordCtrlC = (
	text: string,
	hasPromptParts = false
): boolean => hasPromptParts || text.trim().length >= 20;
export const prependPrompt = (
	entries: PromptHistoryEntry[],
	prompt: PromptHistoryEntry
): PromptHistoryEntry[] => {
	if (entries[0] && same(entries[0], prompt)) {
		return entries;
	}
	return [prompt, ...entries].slice(0, 50);
};
export const resetHistoryNavigation = (
	text: string
): Pick<HistoryState, "draft" | "index"> => ({
	draft: { files: [], text },
	index: -1,
});

export type HistoryState = {
	draft: PromptHistoryEntry;
	entries: PromptHistoryEntry[];
	index: number;
};
export const navigateHistory = (
	state: HistoryState,
	direction: "up" | "down"
): { state: HistoryState; entry: PromptHistoryEntry; consumed: boolean } => {
	const next =
		direction === "up"
			? Math.min(state.entries.length - 1, state.index + 1)
			: Math.max(-1, state.index - 1);
	if (next === state.index) {
		return {
			consumed: false,
			state,
			entry:
				state.index < 0 ? state.draft : (state.entries[state.index] ?? empty()),
		};
	}
	return {
		consumed: true,
		state: { ...state, index: next },
		entry: next < 0 ? state.draft : (state.entries[next] ?? empty()),
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
