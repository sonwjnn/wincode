import type { CommandController } from "@/modules/commands/command-controller";
import type { SubmissionIntent } from "@/modules/commands/submission-resolution";
import type { SessionFilePart } from "@/modules/sessions/message";
import { shiftOffsetThroughRanges } from "@/shared/utils/text-offsets";
import { replaceTextRanges } from "../../pasted-text";
import type { ChatPromptSubmission } from "../../utils";
import type { TrackedCommandSelection } from "./selections";

export type TrackedPastedText = {
	end: number;
	start: number;
	text: string;
	token: string;
};

/** Expand extmark-backed markers without replacing literal lookalikes. */
export const expandTrackedPastedText = (
	text: string,
	markers: readonly TrackedPastedText[]
): string => replaceTextRanges(text, markers);

/** Everything the textarea knows about the composition at submit time. */
export type SubmitSnapshot = {
	files: SessionFilePart[];
	fileTokens: Array<{ start: number; token: string }>;
	pastedTexts: readonly TrackedPastedText[];
	rawText: string;
};

export type SubmitDependencies = {
	commandController: CommandController;
	disabled: boolean;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
	selections: readonly TrackedCommandSelection[];
};

export type PreparedPromptSubmission = {
	accepted: boolean;
	execute: () => Promise<void>;
};

const REJECTED_SUBMISSION: PreparedPromptSubmission = {
	accepted: false,
	execute: async () => undefined,
};

const pastedTextDelta = ({ start, end, text }: TrackedPastedText): number =>
	text.length - (end - start);

/**
 * Prepare selected command intent and the accepted prompt payload without
 * resetting input. Typed text never turns into a command by itself: only the
 * markers the composer tracked as selections carry intent.
 */
export async function preparePromptSubmission(
	dependencies: SubmitDependencies,
	snapshot: SubmitSnapshot
): Promise<PreparedPromptSubmission> {
	if (dependencies.disabled) {
		return REJECTED_SUBMISSION;
	}

	const { files, fileTokens, pastedTexts, rawText } = snapshot;
	const visibleText = rawText.trim();
	// Marker offsets refer to the untrimmed text, so expand before trimming.
	const expandedText = expandTrackedPastedText(rawText, pastedTexts);
	const leadingTrim = expandedText.length - expandedText.trimStart().length;
	const text = expandedText.trim();

	const intents = dependencies.selections
		.flatMap((selection): SubmissionIntent[] => {
			const start =
				shiftOffsetThroughRanges(
					selection.start,
					pastedTexts,
					pastedTextDelta
				) - leadingTrim;
			const end =
				shiftOffsetThroughRanges(selection.end, pastedTexts, pastedTextDelta) -
				leadingTrim;
			if (
				start < 0 ||
				end > text.length ||
				text.slice(start, end) !== selection.marker
			) {
				return [];
			}
			return [
				{
					end,
					kind: selection.kind,
					marker: selection.marker,
					name: selection.name,
					start,
				},
			];
		})
		.toSorted((left, right) => (left.start ?? 0) - (right.start ?? 0));

	if (text.length === 0 && files.length === 0 && intents.length === 0) {
		return REJECTED_SUBMISSION;
	}

	const prepared = await dependencies.commandController.prepareSubmission({
		hasAttachments: files.length > 0,
		intents,
		text,
	});
	if (!prepared) {
		return REJECTED_SUBMISSION;
	}

	const accepted = await prepared.accept((prompt) =>
		dependencies.onSubmit({
			composition: {
				fileTokens,
				files,
				pastedText: pastedTexts.map(({ text, token }) => ({ text, token })),
				text: visibleText,
			},
			files,
			text: prompt.text,
			...(prompt.skill === undefined ? {} : { skill: prompt.skill }),
		})
	);
	return accepted
		? { accepted, execute: prepared.execute }
		: REJECTED_SUBMISSION;
}
