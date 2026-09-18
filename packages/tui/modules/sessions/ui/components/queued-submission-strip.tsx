import { truncateWithOverflow } from "@/shared/display-sanitize";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import type { SessionQueuedSubmission } from "../../engine/types";
import type { SessionSubmissionComposition } from "../../session-operation";

/** How much of one waiting submission fits on its line. */
const MAX_ITEM_CHARS = 80;
/** Maximum rows shown before the queue list scrolls above the composer. */
const QUEUE_VIEWPORT_ROWS = 5;
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
 * The live Submission Queue: a themed panel with one line per waiting
 * submission. The next item is marked so the two Recall gestures have a clear
 * target. The list scrolls when it grows beyond the available footer space, so
 * no queued item is discarded and the composer remains reachable.
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
	return (
		<BorderedContentBlock
			borderColor={colors.borderActive}
			colors={colors}
			contentBackgroundColor={colors.backgroundPanel}
			contentGap={0}
			marginBottom={0}
			paddingX={1}
			paddingY={1}
		>
			<box
				alignItems="center"
				flexDirection="row"
				flexShrink={0}
				marginBottom={1}
				width="100%"
			>
				<text fg={colors.text}>
					<strong fg={colors.primary}>{submissions.length}</strong>
					<span fg={colors.textMuted}> queued</span>
				</text>
				<box flexDirection="row" gap={2} marginLeft="auto">
					<DialogFooterHint
						label="next"
						shortcut="Shift+Up"
						shortcutColor={colors.primary}
					/>
					<DialogFooterHint
						label="all"
						shortcut="Alt+Up"
						shortcutColor={colors.secondary}
					/>
				</box>
			</box>
			<scrollbox
				height={Math.min(QUEUE_VIEWPORT_ROWS, submissions.length)}
				verticalScrollbarOptions={{
					visible: submissions.length > QUEUE_VIEWPORT_ROWS,
				}}
				width="100%"
			>
				{submissions.map((submission, index) => {
					// The oldest waiting submission is the one that runs next, so it
					// is the one the next Recall takes back.
					const isNext = index === 0;
					return (
						<text
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
			</scrollbox>
		</BorderedContentBlock>
	);
}
