import { TextAttributes } from "@opentui/core";
import { truncateWithOverflow } from "@/shared/display-sanitize";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionQueuedSubmission } from "../../engine/types";
import type { SessionSubmissionComposition } from "../../session-operation";

/** How many waiting submissions the strip names before it counts the rest. */
const MAX_VISIBLE_SUBMISSIONS = 3;
/** How much of one waiting submission fits on its line. */
const MAX_ITEM_CHARS = 80;
/** Marks the submission that the next Recall takes back. */
const NEXT_MARKER = "▸";
/** Line breaks and runs of spaces in a composition become one space. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * One waiting submission's line: the text it was composed with, its markers
 * when the composition is nothing but markers, or what it attaches when it
 * carries no text at all. It is always a single line.
 */
const describeSubmission = (
	composition: SessionSubmissionComposition
): string => {
	const markers: Array<{ start: number; token: string }> = [
		...(composition.fileTokens ?? []),
	];
	// Two pastes can produce the same marker, so each is located after the one
	// before it rather than at its first occurrence.
	let cursor = 0;
	for (const { token } of composition.pastedText ?? []) {
		const start = composition.text.indexOf(token, cursor);
		if (start === -1) {
			continue;
		}
		cursor = start + token.length;
		markers.push({ start, token });
	}
	markers.sort((left, right) => right.start - left.start);
	const text = markers
		.reduce(
			(remaining, { start, token }) =>
				remaining.startsWith(token, start)
					? `${remaining.slice(0, start)}${remaining.slice(start + token.length)}`
					: remaining,
			composition.text
		)
		.trim();
	const line = (value: string): string => value.replace(WHITESPACE_RUN, " ");
	if (text.length > 0) {
		return line(text);
	}
	if (composition.files.length === 0) {
		// A composition of markers only, such as one pasted text: what is
		// waiting is exactly what the composer showed.
		return line(composition.text.trim());
	}
	return composition.files.length === 1
		? "1 image"
		: `${composition.files.length} files`;
};

/**
 * One line of the strip: the submission's description, wearing the marker when
 * it is the submission the next Recall takes back. The marker and its separator
 * are added here, so the line's width is measured against one string.
 */
const describeStripLine = (
	composition: SessionSubmissionComposition,
	isNext: boolean
): string => {
	const description = describeSubmission(composition);
	return isNext ? `${NEXT_MARKER} ${description}` : description;
};

/**
 * What is waiting on the Submission Queue: the count, one line per waiting
 * submission with the next one marked, and the keys that recall them. It
 * renders nothing while nothing waits, so the composer never carries an empty
 * affordance.
 */
export function QueuedSubmissionStrip({
	submissions,
}: {
	submissions: readonly SessionQueuedSubmission[];
}) {
	const { colors } = useTheme();
	if (submissions.length === 0) {
		return null;
	}
	const visible = submissions.slice(0, MAX_VISIBLE_SUBMISSIONS);
	const hidden = submissions.length - visible.length;
	return (
		<box flexDirection="column" flexShrink={0} width="100%">
			<box flexDirection="row" flexShrink={0} width="100%">
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`${submissions.length} queued`}
				</text>
				<box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
					<text fg={colors.text}>Shift+Up</text>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						next
					</text>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						·
					</text>
					<text fg={colors.text}>Alt+Up</text>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						all
					</text>
				</box>
			</box>
			{visible.map((submission, index) => {
				// The oldest waiting submission is the one that runs next, so it
				// is the one the next Recall takes back.
				const isNext = index === 0;
				return (
					<text
						attributes={isNext ? TextAttributes.NONE : TextAttributes.DIM}
						fg={isNext ? colors.text : colors.textMuted}
						key={submission.id}
						truncate
					>
						{truncateWithOverflow(
							describeStripLine(submission.input.composition, isNext),
							MAX_ITEM_CHARS
						)}
					</text>
				);
			})}
			{hidden > 0 ? (
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`+${hidden}`}
				</text>
			) : null}
		</box>
	);
}
