import type { ComposerDocumentEditorAdapter } from "@/modules/sessions/ui/composer-document";

export type MemoryComposerEditor = Readonly<{
	adapter: ComposerDocumentEditorAdapter;
	editText: (text: string, cursorOffset: number) => void;
}>;

export const createMemoryComposerEditor = (
	initialText = ""
): MemoryComposerEditor => {
	let text = initialText;
	let cursorOffset = initialText.length;
	let nextMarkId = 1;
	const marks = new Map<number, { end: number; start: number }>();
	const adapter: ComposerDocumentEditorAdapter = {
		createMark: ({ end, start }) => {
			const id = nextMarkId++;
			marks.set(id, { end, start });
			return id;
		},
		deleteMark: (id) => {
			marks.delete(id);
		},
		getCursorOffset: () => cursorOffset,
		getMark: (id) => marks.get(id) ?? null,
		getText: () => text,
		insertText: (value) => {
			text = `${text.slice(0, cursorOffset)}${value}${text.slice(cursorOffset)}`;
			cursorOffset += value.length;
		},
		setCursorOffset: (offset) => {
			cursorOffset = offset;
		},
		setText: (value) => {
			text = value;
			cursorOffset = 0;
			marks.clear();
		},
	};
	return {
		adapter,
		editText: (value, nextCursorOffset) => {
			text = value;
			cursorOffset = nextCursorOffset;
		},
	};
};
