import type { CommandController } from "@/modules/commands/command-controller";
import type { SessionFilePart } from "@/modules/sessions/message";
import { replaceTextRanges } from "../../pasted-text";
import type { ChatPromptSubmission } from "../../utils";

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
};

export type PreparedPromptSubmission = {
	accepted: boolean;
	execute: () => Promise<void>;
};

const REJECTED_SUBMISSION: PreparedPromptSubmission = {
	accepted: false,
	execute: async () => undefined,
};

/** Prepare slash intent and the accepted prompt payload without resetting input. */
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
	const text = expandTrackedPastedText(rawText, pastedTexts).trim();
	if (!text && files.length === 0) {
		return REJECTED_SUBMISSION;
	}

	const prepared = await dependencies.commandController.prepareSubmission({
		hasAttachments: files.length > 0,
		text,
		visibleText,
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
