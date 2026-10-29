import type { Extmark, TextareaRenderable } from "@opentui/core";
import { isUndefined, omitUndefined } from "@wincode/utils";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/submission-types";
import {
	findImageTokenRanges,
	getImageToken,
	getNextImageLabel,
	locateTrackedTokenOccurrences,
	mapOffsetThroughTextReplacement,
} from "../attachments";

export type ComposerDocumentMarkKind = "attachment" | "pasted-text";

export type ComposerDocumentMark = Readonly<{
	end: number;
	kind: ComposerDocumentMarkKind;
	start: number;
	attachmentId?: string;
}>;

/** The narrow editor boundary needed to keep one composition coherent. */
export type ComposerDocumentEditorAdapter = Readonly<{
	createMark: (mark: ComposerDocumentMark) => number;
	deleteMark: (id: number) => void;
	getCursorOffset: () => number;
	getMark: (id: number) => Pick<Extmark, "end" | "start"> | null;
	getText: () => string;
	insertText: (text: string) => void;
	setCursorOffset: (offset: number) => void;
	setText: (text: string) => void;
}>;

export type ComposerDocumentSnapshot = {
	cursorOffset: number;
	fileTokens: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	pastedText: Array<{ start: number; text: string; token: string }>;
	text: string;
};

export type ComposerDocumentEditorChange = Readonly<{
	previousText: string;
	snapshot: ComposerDocumentSnapshot;
}>;

export type ComposerDocument = Readonly<{
	attachEditor: (
		adapter: ComposerDocumentEditorAdapter | null
	) => ComposerDocumentSnapshot;
	capture: () => ComposerDocumentSnapshot;
	clear: () => ComposerDocumentSnapshot;
	insertImage: (file: SessionFilePart) => ComposerDocumentSnapshot;
	insertPastedText: (pasted: {
		text: string;
		token: string;
	}) => ComposerDocumentSnapshot;
	observeEditorChange: () => ComposerDocumentEditorChange | null;
	refreshStyles: () => ComposerDocumentSnapshot;
	replaceText: (
		text: string,
		cursorOffset: number | null
	) => ComposerDocumentSnapshot;
	restore: (
		composition: SessionSubmissionComposition,
		cursorOffset: number | null
	) => ComposerDocumentSnapshot;
}>;

type TrackedAttachment = {
	attachmentId: string;
	file: SessionFilePart;
	markId: number | undefined;
	start: number;
	token: string;
};

type TrackedPastedText = {
	markId: number | undefined;
	start: number;
	text: string;
	token: string;
};

const pastedTextMarks = (
	text: string,
	pastedText: SessionSubmissionComposition["pastedText"]
): Array<{ start: number; text: string; token: string }> => {
	let nextSearchStart = 0;
	const marks: Array<{ start: number; text: string; token: string }> = [];
	for (const pasted of pastedText ?? []) {
		const start = isUndefined(pasted.start)
			? text.indexOf(pasted.token, nextSearchStart)
			: pasted.start;
		if (
			start < nextSearchStart ||
			text.slice(start, start + pasted.token.length) !== pasted.token
		) {
			continue;
		}
		marks.push({ start, text: pasted.text, token: pasted.token });
		nextSearchStart = start + pasted.token.length;
	}
	return marks;
};

const attachmentTokenMarks = (
	text: string,
	composition: SessionSubmissionComposition
): Array<{ file: SessionFilePart; start: number; token: string }> => {
	const fileTokens = composition.fileTokens;
	const ranges =
		fileTokens?.length === composition.files.length
			? fileTokens.map(({ start, token }) => ({
					start,
					token: token.trimEnd(),
				}))
			: findImageTokenRanges(text).map(({ start, token }) => ({
					start,
					token,
				}));
	if (
		ranges.length !== composition.files.length ||
		!ranges.every(
			({ start, token }) => text.slice(start, start + token.length) === token
		)
	) {
		return [];
	}
	return ranges.map((range, index) => ({
		file: composition.files[index] as SessionFilePart,
		...range,
	}));
};

export const createComposerDocument = (
	initialAdapter: ComposerDocumentEditorAdapter | null = null
): ComposerDocument => {
	let adapter = initialAdapter;
	let text = initialAdapter?.getText() ?? "";
	let cursorOffset = initialAdapter?.getCursorOffset() ?? 0;
	let applyingProgrammaticText = false;
	let pendingProgrammaticText: string | null = null;
	let attachments: TrackedAttachment[] = [];
	let pastedTexts: TrackedPastedText[] = [];

	const currentText = (): string => {
		if (adapter) {
			text = adapter.getText();
		}
		return text;
	};

	const currentCursorOffset = (): number => {
		if (adapter) {
			cursorOffset = adapter.getCursorOffset();
		}
		return cursorOffset;
	};

	const recordMark = (
		record:
			| Pick<TrackedAttachment, "markId" | "start" | "token">
			| Pick<TrackedPastedText, "markId" | "start" | "token">
	): Pick<Extmark, "end" | "start"> | null =>
		record.markId === undefined
			? { end: record.start + record.token.length, start: record.start }
			: (adapter?.getMark(record.markId) ?? null);

	const deleteRecordMark = (record: { markId: number | undefined }): void => {
		if (record.markId !== undefined) {
			adapter?.deleteMark(record.markId);
			record.markId = undefined;
		}
	};

	const syncRecords = (): void => {
		const current = currentText();
		currentCursorOffset();
		attachments = attachments
			.filter((attachment) => {
				const mark = recordMark(attachment);
				const valid =
					mark !== null &&
					current.slice(mark.start, mark.end) === attachment.token;
				if (!valid) {
					deleteRecordMark(attachment);
					return false;
				}
				attachment.start = mark.start;
				return true;
			})
			.sort((left, right) => left.start - right.start);
		pastedTexts = pastedTexts
			.filter((pasted) => {
				const mark = recordMark(pasted);
				const valid =
					mark !== null && current.slice(mark.start, mark.end) === pasted.token;
				if (!valid) {
					deleteRecordMark(pasted);
					return false;
				}
				pasted.start = mark.start;
				return true;
			})
			.sort((left, right) => left.start - right.start);
	};

	const createMark = (
		kind: ComposerDocumentMarkKind,
		start: number,
		end: number,
		attachmentId?: string
	): number | undefined =>
		adapter?.createMark({
			attachmentId,
			end,
			kind,
			start,
		});

	const createAttachment = (
		file: SessionFilePart,
		token: string,
		start: number,
		attachmentId: string = crypto.randomUUID()
	): TrackedAttachment => ({
		attachmentId,
		file,
		markId: createMark("attachment", start, start + token.length, attachmentId),
		start,
		token,
	});

	const createPastedText = (
		pasted: { text: string; token: string },
		start: number
	): TrackedPastedText => ({
		markId: createMark("pasted-text", start, start + pasted.token.length),
		start,
		text: pasted.text,
		token: pasted.token,
	});

	const recreateMarks = (): void => {
		for (const attachment of attachments) {
			attachment.markId = createMark(
				"attachment",
				attachment.start,
				attachment.start + attachment.token.length,
				attachment.attachmentId
			);
		}
		for (const pasted of pastedTexts) {
			pasted.markId = createMark(
				"pasted-text",
				pasted.start,
				pasted.start + pasted.token.length
			);
		}
	};

	const capture = (): ComposerDocumentSnapshot => {
		syncRecords();
		return {
			cursorOffset: currentCursorOffset(),
			fileTokens: attachments.map(({ start, token }) => ({ start, token })),
			files: attachments.map(({ file }) => file),
			pastedText: pastedTexts.map(({ start, text, token }) => ({
				start,
				text,
				token,
			})),
			text: currentText(),
		};
	};

	const writeText = (nextText: string): void => {
		text = nextText;
		cursorOffset = 0;
		if (!adapter) {
			return;
		}
		applyingProgrammaticText = true;
		try {
			adapter.setText(nextText);
		} finally {
			applyingProgrammaticText = false;
		}
		pendingProgrammaticText = nextText;
		cursorOffset = adapter.getCursorOffset();
	};

	const writeCursorOffset = (offset: number): void => {
		cursorOffset = offset;
		adapter?.setCursorOffset(offset);
	};

	const deleteAllMarks = (): void => {
		for (const attachment of attachments) {
			deleteRecordMark(attachment);
		}
		for (const pasted of pastedTexts) {
			deleteRecordMark(pasted);
		}
	};

	const attachEditor = (
		nextAdapter: ComposerDocumentEditorAdapter | null
	): ComposerDocumentSnapshot => {
		if (nextAdapter === null) {
			adapter = null;
			pendingProgrammaticText = null;
			for (const attachment of attachments) {
				attachment.markId = undefined;
			}
			for (const pasted of pastedTexts) {
				pasted.markId = undefined;
			}
			return capture();
		}
		if (adapter === nextAdapter) {
			return capture();
		}
		capture();
		deleteAllMarks();
		adapter = nextAdapter;
		if (adapter) {
			const savedCursorOffset = cursorOffset;
			writeText(text);
			writeCursorOffset(savedCursorOffset);
			recreateMarks();
		}
		return capture();
	};

	const refreshStyles = (): ComposerDocumentSnapshot => {
		syncRecords();
		deleteAllMarks();
		recreateMarks();
		return capture();
	};

	const restore = (
		composition: SessionSubmissionComposition,
		nextCursorOffset: number | null
	): ComposerDocumentSnapshot => {
		deleteAllMarks();
		attachments = [];
		pastedTexts = [];
		writeText(composition.text);
		if (nextCursorOffset !== null) {
			writeCursorOffset(nextCursorOffset);
		}
		attachments = attachmentTokenMarks(composition.text, composition).map(
			({ file, start, token }) => createAttachment(file, token, start)
		);
		pastedTexts = pastedTextMarks(composition.text, composition.pastedText).map(
			({ start, text: pastedText, token }) =>
				createPastedText({ text: pastedText, token }, start)
		);
		return capture();
	};

	const replaceText = (
		nextText: string,
		nextCursorOffset: number | null
	): ComposerDocumentSnapshot => {
		syncRecords();
		const previousText = currentText();
		const previousAttachments = attachments.map((attachment) => ({
			attachment,
			start: attachment.start,
		}));
		const previousPastedTexts = pastedTexts.map((pasted) => ({
			pasted,
			start: pasted.start,
		}));
		const attachmentStarts = previousAttachments.map(({ start }) =>
			mapOffsetThroughTextReplacement(previousText, nextText, start)
		);
		const pastedStarts = previousPastedTexts.map(({ start }) =>
			mapOffsetThroughTextReplacement(previousText, nextText, start)
		);

		deleteAllMarks();
		writeText(nextText);
		attachments = locateTrackedTokenOccurrences(
			nextText,
			previousAttachments.map(({ attachment }) => attachment),
			attachmentStarts,
			previousText
		).map(({ record, start }) =>
			createAttachment(record.file, record.token, start, record.attachmentId)
		);
		pastedTexts = locateTrackedTokenOccurrences(
			nextText,
			previousPastedTexts.map(({ pasted }) => pasted),
			pastedStarts,
			previousText
		).map(({ record, start }) => createPastedText(record, start));
		if (nextCursorOffset !== null) {
			writeCursorOffset(nextCursorOffset);
		}
		return capture();
	};

	return {
		attachEditor,
		capture,
		clear: () => restore({ files: [], text: "" }, 0),
		insertImage: (file) => {
			const current = capture();
			const token = getImageToken(getNextImageLabel(current.files.length));
			const start = currentCursorOffset();
			if (adapter) {
				adapter.insertText(`${token} `);
			} else {
				text = `${text.slice(0, start)}${token} ${text.slice(start)}`;
				cursorOffset = start + token.length + 1;
			}
			attachments.push(createAttachment(file, token, start));
			return capture();
		},
		insertPastedText: (pasted) => {
			const start = currentCursorOffset();
			if (adapter) {
				adapter.insertText(`${pasted.token} `);
			} else {
				text = `${text.slice(0, start)}${pasted.token} ${text.slice(start)}`;
				cursorOffset = start + pasted.token.length + 1;
			}
			pastedTexts.push(createPastedText(pasted, start));
			return capture();
		},
		observeEditorChange: () => {
			if (applyingProgrammaticText) {
				return null;
			}
			const previousText = text;
			const nextText = currentText();
			if (pendingProgrammaticText !== null) {
				const matchesProgrammaticText = nextText === pendingProgrammaticText;
				pendingProgrammaticText = null;
				if (matchesProgrammaticText) {
					currentCursorOffset();
					return null;
				}
			}
			const snapshot = capture();
			return { previousText, snapshot };
		},
		refreshStyles,
		replaceText,
		restore,
	};
};

const createOpenTuiAdapter = (
	textarea: TextareaRenderable,
	getStyles: () => Readonly<{ attachment?: number; pastedText?: number }>
): ComposerDocumentEditorAdapter => ({
	createMark: ({ attachmentId, end, kind, start }) => {
		const styles = getStyles();
		const styleId =
			kind === "attachment" ? styles.attachment : styles.pastedText;
		return textarea.extmarks.create({
			end,
			start,
			typeId: kind === "attachment" ? 1 : 0,
			virtual: true,
			...omitUndefined({
				data: attachmentId,
				metadata: isUndefined(attachmentId) ? undefined : { attachmentId },
				priority: kind === "attachment" ? 20 : undefined,
				styleId,
			}),
		});
	},
	deleteMark: (id) => {
		textarea.extmarks.delete(id);
	},
	getCursorOffset: () => textarea.cursorOffset,
	getMark: (id) => {
		const mark = textarea.extmarks.get(id);
		return mark === null ? null : mark;
	},
	getText: () => textarea.plainText,
	insertText: (value) => textarea.insertText(value),
	setCursorOffset: (offset) => {
		textarea.cursorOffset = offset;
	},
	setText: (value) => textarea.setText(value),
});

export const attachComposerDocumentToTextarea = (
	document: ComposerDocument,
	textarea: TextareaRenderable,
	getStyles: () => Readonly<{ attachment?: number; pastedText?: number }>
): ComposerDocumentSnapshot =>
	document.attachEditor(createOpenTuiAdapter(textarea, getStyles));
