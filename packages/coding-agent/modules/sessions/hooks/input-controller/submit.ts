import type { CommandSpec } from "@/modules/commands/commands";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { Skill } from "@/modules/skills";
import { replaceTextRanges } from "../../pasted-text";
import { resolveSubmissionPrompt } from "../../submission-preparation";
import type { ChatPromptSubmission } from "../../utils";
import { findBuiltinCommand } from "./builtin-command";
export type TrackedPastedText = {
	end: number;
	start: number;
	text: string;
	token: string;
};

/** Expand extmark-backed markers without replacing literal lookalikes. */
const expandTrackedPastedText = (
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
	disabled: boolean;
	discoverCustomCommands: () => Promise<CustomCommandSpec[]>;
	discoverSkills: () => Promise<Skill[]>;
	onError: (message: string) => void;
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | void | Promise<void>;
};

/**
 * The Built-in Command one composition invokes, or null when the line is
 * ordinary prompt text. Pasted-text markers are expanded first, so a focus
 * pasted after `/compact ` reaches the command as the pasted content, and a
 * composition carrying attachments stays a prompt.
 */
export const resolveBuiltinCommand = (
	snapshot: SubmitSnapshot
): CommandSpec | null =>
	snapshot.files.length === 0
		? findBuiltinCommand(
				expandTrackedPastedText(snapshot.rawText, snapshot.pastedTexts)
			)
		: null;

/**
 * Resolve Skill/Custom Command intent once for every surface, then hand the
 * prepared composition to its transport. History and input reset remain
 * acceptance-owned by the caller.
 */
export async function submitPrompt(
	dependencies: SubmitDependencies,
	snapshot: SubmitSnapshot
): Promise<boolean> {
	if (dependencies.disabled) {
		return false;
	}

	const { files, fileTokens, pastedTexts, rawText } = snapshot;
	const visibleText = rawText.trim();
	// Markers carry offsets into the untrimmed composition, so expand before
	// trimming or a leading space shifts every replacement.
	const text = expandTrackedPastedText(rawText, pastedTexts).trim();
	if (!text && files.length === 0) {
		return false;
	}

	const resolution = await resolveSubmissionPrompt({
		text,
		visibleText,
		discoverSkills: dependencies.discoverSkills,
		discoverCustomCommands: dependencies.discoverCustomCommands,
	});
	if (resolution.kind === "rejected") {
		dependencies.onError(resolution.reason);
		return false;
	}

	const accepted = await dependencies.onSubmit({
		composition: {
			fileTokens,
			files,
			pastedText: pastedTexts.map(({ text, token }) => ({ text, token })),
			text: visibleText,
		},
		files,
		text: resolution.text,
		...(resolution.skill === undefined ? {} : { skill: resolution.skill }),
	});
	return accepted !== false;
}
