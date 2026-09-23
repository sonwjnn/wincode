import { truncateWithOverflow } from "@/shared/display-sanitize";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import type {
	SessionQueuedSubmission,
	SessionSteeringMessage,
	SessionWaitingMessageId,
} from "../../engine/types";
import type { SessionSubmissionComposition } from "../../session-operation";

/** How much of one waiting message fits on its line. */
const MAX_ITEM_CHARS = 80;
/** Maximum rows shown before the waiting list scrolls above the composer. */
const QUEUE_VIEWPORT_ROWS = 5;
/** Marks the message that the next Recall takes back; it has a fixed width. */
const NEXT_MARKER = "▸ ";
/** Keeps an unmarked message's text in the column a marked one's starts in. */
const NO_MARKER = "  ";
/**
 * The lane tags. The shorter one is padded so both tags occupy the same
 * columns, and a description starts in the same place whichever lane it waits
 * in.
 */
const STEERING_LANE_TAG = "steering";
const QUEUED_LANE_TAG = "queued".padEnd(STEERING_LANE_TAG.length);
/** Line breaks and runs of spaces in a composition become one space. */
const WHITESPACE_RUN = /\s+/gu;

/** Which lane a waiting message belongs to, and the tag its row shows. */
type WaitingLane = "queued" | "steering";

/** One message waiting to run, as its row shows it. */
type WaitingRow = {
	readonly composition: SessionSubmissionComposition;
	readonly id: SessionWaitingMessageId;
	/** Whether the next Recall takes this message back. */
	readonly isNext: boolean;
	readonly lane: WaitingLane;
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
 * The live waiting lanes: a transparent strip with one line per message, the
 * Steering Lane's first and the Submission Queue's behind it. The message the
 * next Recall takes back wears the marker, and each row names its lane so a
 * user can tell what joins the running turn from what runs as its own turn.
 * The list scrolls when it grows beyond the available footer space, so no
 * waiting message is discarded and the composer remains reachable.
 */
export function WaitingMessageStrip({
	queued,
	steering,
}: {
	queued: readonly SessionQueuedSubmission[];
	steering: readonly SessionSteeringMessage[];
}) {
	const { colors } = useTheme();
	// The waiting messages in the order they run: the Steering Lane first — its
	// oldest joins the running Agent Turn at the next Model Step boundary — then
	// the Submission Queue, whose oldest runs as its own Agent Turn. The head of
	// the Steering Lane leads when it holds anything, so the message the next
	// Recall takes back is the one that runs next.
	const rows: WaitingRow[] = [
		...steering.map(
			({ id, input }, index): WaitingRow => ({
				composition: input.composition,
				id,
				isNext: index === 0,
				lane: "steering",
			})
		),
		...queued.map(
			({ id, input }, index): WaitingRow => ({
				composition: input.composition,
				id,
				isNext: steering.length === 0 && index === 0,
				lane: "queued",
			})
		),
	];
	if (rows.length === 0) {
		return null;
	}
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
				height={Math.min(QUEUE_VIEWPORT_ROWS, rows.length)}
				verticalScrollbarOptions={{
					visible: rows.length > QUEUE_VIEWPORT_ROWS,
				}}
				width="100%"
			>
				{rows.map((row) => {
					const isSteering = row.lane === "steering";
					const laneTag = isSteering ? STEERING_LANE_TAG : QUEUED_LANE_TAG;
					const line = truncateWithOverflow(
						`${row.isNext ? NEXT_MARKER : NO_MARKER}${laneTag} ${describeSubmission(row.composition)}`,
						MAX_ITEM_CHARS
					);
					// The marker and the lane tag are fixed-width columns, so the
					// coloured slices of the line always fall on the same columns.
					const descriptionStart = NEXT_MARKER.length + laneTag.length + 1;
					return (
						<text
							fg={row.isNext ? colors.text : colors.textMuted}
							key={row.id}
							truncate
						>
							<span fg={colors.primary}>
								{line.slice(0, NEXT_MARKER.length)}
							</span>
							<span fg={isSteering ? colors.secondary : colors.textMuted}>
								{line.slice(NEXT_MARKER.length, descriptionStart)}
							</span>
							<span>{line.slice(descriptionStart)}</span>
						</text>
					);
				})}
			</scrollbox>
		</box>
	);
}
