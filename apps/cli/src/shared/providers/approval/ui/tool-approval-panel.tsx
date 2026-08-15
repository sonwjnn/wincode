import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	type ApprovalPanelEntry,
	useApprovalPanels,
} from "../approval-panels-provider";
import {
	formatApprovalDescription,
	formatApprovalIdentity,
	formatApprovalInput,
	formatRejectionFeedback,
} from "../format";
import type { ApprovalOutcome, ToolApprovalRequest } from "../types";

const MAX_APPROVAL_HEADER_CHARS = 200;

type ApprovalOption =
	| { kind: "allow-once"; label: string }
	| { kind: "always"; label: string }
	| { kind: "reject"; label: string };

const buildOptions = (safety: boolean): ApprovalOption[] => {
	const allowOnce: ApprovalOption = {
		kind: "allow-once",
		label: "Allow once",
	};
	const reject: ApprovalOption = { kind: "reject", label: "Reject" };
	// A safety ask must never mint a grant, so "always" is omitted under the
	// manual-only ceiling; only allow-once and reject remain.
	return safety
		? [allowOnce, reject]
		: [allowOnce, { kind: "always", label: "Always allow" }, reject];
};

/**
 * One compact identity line for the inline panel, bounded so a hostile or
 * enormous tool schema cannot flood the conversation.
 */
const formatApprovalHeader = (request: ToolApprovalRequest): string => {
	const identity = request.identity
		.map((row) => `${row.label}: ${formatApprovalIdentity(row.value)}`)
		.join(" · ");
	const description =
		request.description.length > 0
			? ` — ${formatApprovalDescription(request.description)}`
			: "";
	const header = `${identity}${description}`;
	return header.length <= MAX_APPROVAL_HEADER_CHARS
		? header
		: `${header.slice(0, MAX_APPROVAL_HEADER_CHARS)}…`;
};

/**
 * The inline replacement for the modal Tool Approval dialog: an opencode-style
 * flat panel anchored to the pending tool call in the conversation timeline.
 * The selection keys, once/always/reject semantics, and safety-ceiling rules
 * are unchanged from the dialog; only the container and the compact layout
 * differ. After resolution the panel collapses to a one-line audit record.
 */
export function ToolApprovalPanel({ id }: { id: string }) {
	const { entries } = useApprovalPanels();
	const entry = entries.find((candidate) => candidate.id === id);
	if (entry === undefined) {
		return null;
	}
	if (entry.resolution !== undefined) {
		return <ApprovalResolvedLine resolution={entry.resolution} />;
	}
	return <ApprovalPendingPanel entry={entry} />;
}

const APPROVAL_RESOLUTION_LABELS: Record<ApprovalOutcome, string> = {
	"allow-once": "allowed once",
	always: "always allowed",
	rejected: "rejected",
};

function ApprovalResolvedLine({
	resolution,
}: {
	resolution: NonNullable<ApprovalPanelEntry["resolution"]>;
}) {
	const { colors } = useTheme();
	const isRejected = resolution.outcome === "rejected";
	return (
		<box marginBottom={1} paddingX={3} width="100%">
			<text fg={isRejected ? colors.error : colors.textMuted}>
				{isRejected ? "✗ " : "✓ "}
				{APPROVAL_RESOLUTION_LABELS[resolution.outcome]}
				{resolution.feedback === undefined ? null : (
					<span fg={colors.textMuted}>{` — ${resolution.feedback}`}</span>
				)}
			</text>
		</box>
	);
}

type ApprovalPendingPanelProps = {
	entry: ApprovalPanelEntry;
};

function ApprovalPendingPanel({ entry }: ApprovalPendingPanelProps) {
	const { colors } = useTheme();
	const { isTopLayer, pop, push } = useKeyboardLayer();
	const { resolve, resolveAll } = useApprovalPanels();
	const layerId = `approval-panel-${entry.id}`;
	const { actions, request } = entry;
	const options = buildOptions(request.safety === true);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [inputExpanded, setInputExpanded] = useState(false);
	const selectedIndexRef = useRef(0);
	const feedbackRef = useRef<InputRenderable>(null);

	// The panel owns a keyboard layer for the duration of the pending request,
	// so conversation navigation and typing pause while a decision is owed.
	// Ctrl+C walks the responder chain and cancels the request, mirroring the
	// dialog's ctrl+c behavior. Unmounting while still pending (conversation
	// switch or clear) cancels the request too, so the approval queue never
	// hangs on an orphaned panel; the queue settles each request at most once,
	// so this is a no-op after a normal allow/reject.
	useEffect(() => {
		push(layerId, () => {
			actions.cancel();
			resolve(entry.id, "rejected");
			return true;
		});
		return () => {
			pop(layerId);
			actions.cancel();
		};
	}, [actions, entry.id, layerId, pop, push, resolve]);

	// OpenTUI keyboard callbacks are imperative and several keys can land before
	// React commits the next render. Mirror the selection into a ref and advance
	// it synchronously so enter always resolves against the latest selection even
	// under rapid input.
	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	const moveSelection = (delta: number) => {
		const count = options.length;
		const next = (selectedIndexRef.current + delta + count) % count;
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	};

	const settle = (outcome: ApprovalOutcome, feedback?: string) => {
		resolve(entry.id, outcome, feedback);
	};

	const confirm = (index: number) => {
		const option = options[index];
		if (option === undefined) {
			return;
		}
		if (option.kind === "reject") {
			// The feedback is bounded before it leaves the panel so the audit line
			// and the queue see the same value; the queue re-bounds idempotently.
			// Reject settles every sibling panel too, because the queue behind it
			// rejects all pending approvals in the conversation.
			const feedback = formatRejectionFeedback(
				feedbackRef.current?.value ?? undefined
			);
			actions.reject(feedback);
			resolveAll("rejected", feedback);
			return;
		}
		const remember = option.kind === "always";
		actions.allow(remember);
		settle(remember ? "always" : "allow-once");
	};

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "up") {
			key.preventDefault();
			moveSelection(-1);
			return;
		}
		if (key.name === "down" || key.name === "tab") {
			key.preventDefault();
			moveSelection(1);
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			confirm(selectedIndexRef.current);
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			actions.cancel();
			settle("rejected");
			return;
		}
		// Expand the call input only while the feedback field is not focused, so
		// typing the letter reaches the field instead of toggling the panel.
		if (
			key.name === "e" &&
			options[selectedIndexRef.current]?.kind !== "reject"
		) {
			key.preventDefault();
			setInputExpanded((expanded) => !expanded);
		}
	});

	const showFeedback = options[selectedIndex]?.kind === "reject";

	return (
		<box flexDirection="column" marginBottom={1} paddingX={3} width="100%">
			{request.safety === true && (
				<text attributes={TextAttributes.BOLD} fg={colors.error}>
					{request.safetyReason ??
						"Safety ceiling: the governing Tool Permission config is malformed, so every action must be approved manually."}
				</text>
			)}
			<text fg={colors.text}>{formatApprovalHeader(request)}</text>
			{inputExpanded ? (
				<text
					attributes={TextAttributes.DIM}
					fg={colors.textMuted}
					wrapMode="word"
				>
					{formatApprovalInput(request.input)}
				</text>
			) : (
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					e input
				</text>
			)}
			<box flexDirection="row" gap={3} height={1}>
				{options.map((option, index) => {
					const isSelected = index === selectedIndex;
					const color =
						option.kind === "reject" ? colors.error : colors.primary;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events.
						<text
							attributes={isSelected ? TextAttributes.BOLD : undefined}
							fg={isSelected ? color : colors.text}
							key={option.kind}
							onMouseDown={() => confirm(index)}
						>
							{option.label}
						</text>
					);
				})}
			</box>
			{showFeedback && (
				<>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						feedback (optional)
					</text>
					<input
						focused
						focusedTextColor={colors.text}
						onContentChange={() => undefined}
						ref={feedbackRef}
						textColor={colors.text}
					/>
				</>
			)}
		</box>
	);
}
