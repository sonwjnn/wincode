import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { BorderedContentBlock } from "@/shared/ui/bordered-content-block";
import {
	type ApprovalPanelEntry,
	useApprovalPanels,
} from "../approval-panels-provider";
import {
	formatApprovalDescription,
	formatApprovalIdentity,
	formatApprovalInput,
} from "../format";
import type { ApprovalOutcome, ToolApprovalRequest } from "../types";

const MAX_APPROVAL_HEADER_CHARS = 200;

type ApprovalOption =
	| { kind: "abort"; label: string }
	| { kind: "allow-once"; label: string }
	| { kind: "always"; label: string }
	| { kind: "reject"; label: string };

const buildOptions = (
	safety: boolean,
	showAbort: boolean
): ApprovalOption[] => {
	const allowOnce: ApprovalOption = {
		kind: "allow-once",
		label: "Allow once",
	};
	const reject: ApprovalOption = { kind: "reject", label: "Reject" };
	const options: ApprovalOption[] = safety
		? [allowOnce, reject]
		: [allowOnce, { kind: "always", label: "Always allow" }, reject];
	if (showAbort) {
		options.push({ kind: "abort", label: "Abort" });
	}
	return options;
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
 * Renders pending approval controls or the settled audit line for one request.
 * Pending controls replace the composer; message callsites use resolved-only
 * mode so the timeline retains only the durable audit record.
 */
export function ToolApprovalPanel({
	active = true,
	fullscreen = false,
	id,
	mode = "all",
	pendingCount = 1,
	position = 1,
}: {
	active?: boolean;
	fullscreen?: boolean;
	id: string;
	mode?: "all" | "resolved-only";
	pendingCount?: number;
	position?: number;
}) {
	const { entries } = useApprovalPanels();
	const entry = entries.find((candidate) => candidate.id === id);
	if (entry === undefined) {
		return null;
	}
	if (entry.resolution !== undefined) {
		return <ApprovalResolvedLine resolution={entry.resolution} />;
	}
	if (mode === "resolved-only") {
		return null;
	}
	if (!active) {
		return (
			<ApprovalWaitingCard
				entry={entry}
				pendingCount={pendingCount}
				position={position}
			/>
		);
	}
	return (
		<ApprovalPendingPanel
			entry={entry}
			fullscreen={fullscreen}
			pendingCount={pendingCount}
			position={position}
		/>
	);
}

/**
 * A read-only queued card in the fullscreen stack: it shows the request
 * context and its position but no controls, keyboard layer, or focus target.
 */
function ApprovalWaitingCard({
	entry,
	pendingCount,
	position,
}: {
	entry: ApprovalPanelEntry;
	pendingCount: number;
	position: number;
}) {
	const { colors } = useTheme();
	const { request } = entry;
	return (
		<BorderedContentBlock
			borderColor={request.safety === true ? colors.error : colors.warning}
			colors={colors}
			contentBackgroundColor={colors.backgroundPanel}
			contentGap={0}
			marginBottom={0}
			paddingX={0}
			paddingY={0}
		>
			<box flexDirection="column" gap={1} padding={1} paddingLeft={2}>
				<box flexDirection="row" gap={1} justifyContent="space-between">
					<box flexDirection="row" gap={1}>
						<text fg={request.safety === true ? colors.error : colors.warning}>
							△
						</text>
						<text fg={colors.textMuted}>
							<strong>Permission required</strong>
						</text>
					</box>
					{pendingCount > 1 ? (
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							{position} of {pendingCount}
						</text>
					) : null}
				</box>
				{request.safety === true && (
					<text attributes={TextAttributes.BOLD} fg={colors.error}>
						{request.safetyReason ??
							"Safety ceiling: the governing Tool Permission config is malformed, so every action must be approved manually."}
					</text>
				)}
				<box flexDirection="row" gap={1} paddingLeft={2}>
					<text fg={colors.textMuted}>→</text>
					<text
						attributes={TextAttributes.DIM}
						fg={colors.textMuted}
						wrapMode="word"
					>
						{formatApprovalHeader(request)}
					</text>
				</box>
			</box>
		</BorderedContentBlock>
	);
}

export function PendingApprovalDock({
	fullscreen = false,
}: {
	fullscreen?: boolean;
}) {
	const pendingEntries = useApprovalPanels().entries.filter(
		(entry) => entry.resolution === undefined
	);
	const pendingEntry = pendingEntries[0];
	if (pendingEntry === undefined) {
		return null;
	}
	if (!fullscreen) {
		return (
			<box width="100%">
				<ToolApprovalPanel
					id={pendingEntry.id}
					pendingCount={pendingEntries.length}
					position={1}
				/>
			</box>
		);
	}
	return (
		<box flexGrow={1} height="100%" paddingY={1} width="100%">
			<scrollbox
				flexGrow={1}
				height="100%"
				id="approval-stack-scrollbox"
				verticalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1} width="100%">
					{pendingEntries.map((entry, index) => (
						<ToolApprovalPanel
							active={index === 0}
							fullscreen={index === 0}
							id={entry.id}
							key={entry.id}
							pendingCount={pendingEntries.length}
							position={index + 1}
						/>
					))}
				</box>
			</scrollbox>
		</box>
	);
}
const APPROVAL_RESOLUTION_LABELS: Record<ApprovalOutcome, string> = {
	aborted: "aborted",
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
	const isDenied =
		resolution.outcome === "aborted" || resolution.outcome === "rejected";
	return (
		<box marginBottom={1} paddingX={3} width="100%">
			<text fg={isDenied ? colors.error : colors.textMuted}>
				{isDenied ? "✗ " : "✓ "}
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
	fullscreen: boolean;
	pendingCount: number;
	position: number;
};

function ApprovalPendingPanel({
	entry,
	fullscreen,
	pendingCount,
	position,
}: ApprovalPendingPanelProps) {
	const { colors } = useTheme();
	const dimensions = useTerminalDimensions();
	const { isTopLayer, pop, push } = useKeyboardLayer();
	const { resolve } = useApprovalPanels();
	const layerId = `approval-panel-${entry.id}`;
	const { actions, request } = entry;
	const options = buildOptions(request.safety === true, pendingCount > 1);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [inputExpanded, setInputExpanded] = useState(false);
	const selectedIndexRef = useRef(0);

	// Leaving approval mode is an explicit turn abort: settle every pending
	// request through the conversation abort path instead of rejecting one tool.
	useEffect(() => {
		push(layerId, () => {
			actions.abort();
			resolve(entry.id, "aborted");
			return true;
		});
		return () => {
			pop(layerId);
		};
	}, [actions, entry.id, layerId, pop, push, resolve]);

	// OpenTUI keyboard callbacks are imperative and several keys can land before
	// it synchronously so enter always resolves against the latest selection even
	// under rapid input.
	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	const selectIndex = (index: number) => {
		selectedIndexRef.current = index;
		setSelectedIndex(index);
	};

	const moveSelection = (delta: number) => {
		const count = options.length;
		selectIndex((selectedIndexRef.current + delta + count) % count);
	};

	const settle = (outcome: ApprovalOutcome) => {
		resolve(entry.id, outcome);
	};

	const confirm = (index: number) => {
		const option = options[index];
		if (option === undefined) {
			return;
		}
		if (option.kind === "abort") {
			actions.abort();
			settle("aborted");
			return;
		}
		if (option.kind === "reject") {
			if (pendingCount === 1) {
				actions.abort();
				settle("aborted");
			} else {
				actions.reject(undefined);
				settle("rejected");
			}
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
		if (key.name === "escape") {
			key.preventDefault();
			actions.abort();
			settle("aborted");
			return;
		}
		if (key.name === "left" || key.name === "up") {
			key.preventDefault();
			moveSelection(-1);
			return;
		}
		if (key.name === "right" || key.name === "down" || key.name === "tab") {
			key.preventDefault();
			moveSelection(1);
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			confirm(selectedIndexRef.current);
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

	return (
		<BorderedContentBlock
			borderColor={request.safety === true ? colors.error : colors.warning}
			colors={colors}
			contentBackgroundColor={colors.backgroundPanel}
			contentGap={0}
			contentJustifyContent={fullscreen ? "space-between" : undefined}
			fill={fullscreen}
			marginBottom={0}
			paddingX={0}
			paddingY={0}
		>
			<box flexDirection="column" gap={1} padding={1} paddingLeft={2}>
				<box flexDirection="row" gap={1} justifyContent="space-between">
					<box flexDirection="row" gap={1}>
						<text fg={request.safety === true ? colors.error : colors.warning}>
							△
						</text>
						<text fg={colors.text}>
							<strong>Permission required</strong>
						</text>
					</box>
					{pendingCount > 1 ? (
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							{position} of {pendingCount}
						</text>
					) : null}
				</box>
				{request.safety === true && (
					<text attributes={TextAttributes.BOLD} fg={colors.error}>
						{request.safetyReason ??
							"Safety ceiling: the governing Tool Permission config is malformed, so every action must be approved manually."}
					</text>
				)}
				<box flexDirection="row" gap={1} paddingLeft={2}>
					<text fg={colors.textMuted}>→</text>
					<text fg={colors.text} wrapMode="word">
						{formatApprovalHeader(request)}
					</text>
				</box>
				{inputExpanded ? (
					<box paddingLeft={2}>
						<text
							attributes={TextAttributes.DIM}
							fg={colors.textMuted}
							wrapMode="word"
						>
							{formatApprovalInput(request.input)}
						</text>
					</box>
				) : (
					<box paddingLeft={2}>
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							e input
						</text>
					</box>
				)}
			</box>
			<box
				alignItems={dimensions.width < 80 ? "flex-start" : "center"}
				backgroundColor={colors.backgroundElement}
				flexDirection={dimensions.width < 80 ? "column" : "row"}
				gap={1}
				justifyContent={dimensions.width < 80 ? "flex-start" : "space-between"}
				padding={1}
				paddingLeft={2}
			>
				<box flexDirection="row" gap={1}>
					{options.map((option, index) => {
						const isSelected = index === selectedIndex;
						const accent =
							option.kind === "abort" || option.kind === "reject"
								? colors.error
								: colors.warning;
						const selectedTextColor = getContrastingTextColor(accent);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
							<box
								backgroundColor={isSelected ? accent : colors.backgroundMenu}
								key={option.kind}
								onMouseDown={() => confirm(index)}
								onMouseMove={() => selectIndex(index)}
								paddingX={1}
							>
								<text fg={isSelected ? selectedTextColor : colors.textMuted}>
									{option.label}
								</text>
							</box>
						);
					})}
				</box>
				<box flexDirection="row" gap={2}>
					<text fg={colors.text}>
						ctrl+f{" "}
						<span fg={colors.textMuted}>
							{fullscreen ? "minimize" : "fullscreen"}
						</span>
					</text>
					<text fg={colors.text}>
						⇄ <span fg={colors.textMuted}>select</span>
					</text>
					<text fg={colors.text}>
						enter <span fg={colors.textMuted}>confirm</span>
					</text>
				</box>
			</box>
		</BorderedContentBlock>
	);
}
