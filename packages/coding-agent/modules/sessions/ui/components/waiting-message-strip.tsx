import { truncateWithOverflow } from "@/shared/display-sanitize";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import type { SessionQueuedSubmission } from "../../agent-session/types";
import { replaceTextRanges } from "../../pasted-text";
import type { SessionSubmissionComposition } from "../../submission-types";

/** How much of one waiting message fits on its line. */
const MAX_ITEM_CHARS = 80;
/** Maximum rows shown before the waiting list scrolls above the composer. */
const QUEUE_VIEWPORT_ROWS = 5;
/** Marks the next queued entry Recall can take back; it has a fixed width. */
const NEXT_MARKER = "▸ ";
/** Keeps an unmarked message's text in the column a marked one's starts in. */
const NO_MARKER = "  ";
const QUEUED_LANE_TAG = "queued";
/** Line breaks and runs of spaces in a composition become one space. */
const WHITESPACE_RUN = /\s+/gu;

type WaitingRow = {
	readonly composition: SessionSubmissionComposition;
	readonly id: string;
	/** Whether this uncommitted message is the next Recall will take back. */
	readonly isNext: boolean;
};

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
	const replacements = markers.flatMap(({ start, token }) =>
		composition.text.startsWith(token, start)
			? [{ end: start + token.length, start, text: "" }]
			: []
	);
	const text = replaceTextRanges(composition.text, replacements).trim();
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

/** Shows only uncommitted queued submissions, the work eligible for Recall. */
export function WaitingMessageStrip({
	queued,
}: {
	queued: readonly SessionQueuedSubmission[];
}) {
	const { colors } = useTheme();
	const rows: WaitingRow[] = queued.map(
		({ id, input }, index): WaitingRow => ({
			composition: input.composition,
			id,
			isNext: index === 0,
		})
	);
	if (rows.length === 0) {
		return null;
	}
	const visibleLineCount = rows.length;
	return (
		<box
			backgroundColor="transparent"
			flexDirection="column"
			flexShrink={0}
			paddingX={1}
			paddingY={1}
			width="100%"
		>
			<box
				alignItems="center"
				flexDirection="row"
				flexShrink={0}
				marginBottom={1}
				width="100%"
			>
				<text fg={colors.text}>
					<strong fg={colors.primary}>{rows.length}</strong>
					<span fg={colors.textMuted}> waiting</span>
				</text>
				{queued.length > 0 && (
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
				)}
			</box>
			<scrollbox
				height={Math.min(QUEUE_VIEWPORT_ROWS, visibleLineCount)}
				verticalScrollbarOptions={{
					visible: visibleLineCount > QUEUE_VIEWPORT_ROWS,
				}}
				width="100%"
			>
				{rows.map((row) => {
					const line = truncateWithOverflow(
						`${row.isNext ? NEXT_MARKER : NO_MARKER}${QUEUED_LANE_TAG} ${describeSubmission(row.composition)}`,
						MAX_ITEM_CHARS
					);
					const descriptionStart =
						NEXT_MARKER.length + QUEUED_LANE_TAG.length + 1;
					return (
						<box flexDirection="column" key={row.id} width="100%">
							<text fg={row.isNext ? colors.text : colors.textMuted} truncate>
								<span fg={colors.primary}>
									{line.slice(0, NEXT_MARKER.length)}
								</span>
								<span fg={colors.textMuted}>
									{line.slice(NEXT_MARKER.length, descriptionStart)}
								</span>
								<span>{line.slice(descriptionStart)}</span>
							</text>
						</box>
					);
				})}
			</scrollbox>
		</box>
	);
}
