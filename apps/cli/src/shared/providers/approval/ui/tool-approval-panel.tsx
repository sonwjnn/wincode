import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { sanitizeText } from "@/shared/display-sanitize";
import { useLatest } from "@/shared/hooks/use-latest";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
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
	errorText,
	id,
	mode = "all",
	pendingCount = 1,
	position = 1,
}: {
	errorText?: string;
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
		return <ApprovalResolvedLine entry={entry} errorText={errorText} />;
	}
	if (mode === "resolved-only") {
		return null;
	}
	return (
		<ApprovalPendingPanel
			entry={entry}
			pendingCount={pendingCount}
			position={position}
		/>
	);
}
export function PendingApprovalDock() {
	const pendingEntries = useApprovalPanels().entries.filter(
		(entry) => entry.resolution === undefined
	);
	const pendingEntry = pendingEntries[0];
	if (pendingEntry === undefined) {
		return null;
	}
	return (
		<box width="100%">
			<ToolApprovalPanel
				id={pendingEntry.id}
				key={pendingEntry.id}
				pendingCount={pendingEntries.length}
				position={1}
			/>
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
	entry,
	errorText,
}: {
	entry: ApprovalPanelEntry;
	errorText?: string;
}) {
	const { colors } = useTheme();
	const resolution = entry.resolution;
	if (resolution === undefined) {
		return null;
	}
	const isDenied =
		resolution.outcome === "aborted" || resolution.outcome === "rejected";
	const sanitizedErrorText =
		errorText === undefined ? "" : sanitizeText(errorText);
	// The gated resource already renders on the tool row above, so the audit
	// line strips the trailing `: resource` identity from the reason instead
	// of repeating it. Feedback and non-gate wording stay untouched.
	const identityResource = entry.request.identity.find(
		(row) => row.label === "resource"
	)?.value;
	const displayErrorText =
		identityResource === undefined
			? sanitizedErrorText
			: sanitizedErrorText.replace(`: ${identityResource}`, "");
	const denialReason = displayErrorText || resolution.feedback;
	const displayLabel =
		isDenied && denialReason !== undefined
			? denialReason
			: APPROVAL_RESOLUTION_LABELS[resolution.outcome];
	return (
		<box marginBottom={1} paddingX={3} width="100%">
			<text fg={isDenied ? colors.error : colors.textMuted}>
				{isDenied ? "✗ " : "✓ "}
				{displayLabel}
				{!isDenied && resolution.feedback !== undefined ? (
					<span fg={colors.textMuted}>{` — ${resolution.feedback}`}</span>
				) : null}
			</text>
		</box>
	);
}

type ApprovalPendingPanelProps = {
	entry: ApprovalPanelEntry;
	pendingCount: number;
	position: number;
};

function ApprovalPendingPanel({
	entry,
	pendingCount,
	position,
}: ApprovalPendingPanelProps) {
	const { colors } = useTheme();
	const dimensions = useTerminalDimensions();
	const { isTopLayer, pop, push } = useKeyboardLayer();
	const { resolve } = useApprovalPanels();
	const layerId = `approval-panel-${entry.id}`;
	const confirmLayerId = `approval-confirm-${entry.id}`;
	const { actions, request } = entry;
	const options = buildOptions(request.safety === true, pendingCount > 1);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [confirmAlways, setConfirmAlways] = useState(false);
	const [inputExpanded, setInputExpanded] = useState(false);
	const selectedIndexRef = useLatest(selectedIndex);
	// Imperative keys can land before a render commits, so the armed confirm is
	// also tracked in a ref like the selection itself.
	const confirmAlwaysRef = useRef(false);

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

	// The always-allow confirm is a pushed overlay: it owns the keyboard layer
	// while armed, so enter/escape resolve against the confirm and the
	// permission panel regains the keys as soon as the overlay pops.
	useEffect(() => {
		if (!confirmAlways) {
			return;
		}
		push(confirmLayerId);
		return () => {
			pop(confirmLayerId);
		};
	}, [confirmAlways, confirmLayerId, pop, push]);

	const armConfirm = () => {
		confirmAlwaysRef.current = true;
		setConfirmAlways(true);
	};

	const cancelConfirm = () => {
		confirmAlwaysRef.current = false;
		setConfirmAlways(false);
	};

	const selectIndex = (index: number) => {
		// Moving the selection to a different option cancels an armed
		// always-allow confirm so a stray arrow or hover can never mint a
		// persistent grant. Re-selecting the same option keeps it armed so a
		// second click on the armed option confirms it.
		if (index !== selectedIndexRef.current) {
			cancelConfirm();
		}
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

	const grantAlways = () => {
		actions.allow(true);
		settle("always");
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
		if (option.kind === "always" && !confirmAlwaysRef.current) {
			// "Always allow" mints a persistent grant: require a second explicit
			// enter/click so one stray keypress cannot authorize every future call.
			selectIndex(index);
			armConfirm();
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
			if (confirmAlwaysRef.current) {
				cancelConfirm();
				return;
			}
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
		<box position="relative" width="100%">
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
							<text
								fg={request.safety === true ? colors.error : colors.warning}
							>
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
							Safety ceiling: the governing Tool Permission config is malformed,
							so every action must be approved manually.
						</text>
					)}
					<box flexDirection="row" paddingLeft={2}>
						<text fg={colors.textMuted}>{"→ "}</text>
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
				{!confirmAlways && (
					<box
						alignItems={dimensions.width < 80 ? "flex-start" : "center"}
						backgroundColor={colors.backgroundElement}
						flexDirection={dimensions.width < 80 ? "column" : "row"}
						gap={1}
						justifyContent={
							dimensions.width < 80 ? "flex-start" : "space-between"
						}
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
										backgroundColor={
											isSelected ? accent : colors.backgroundMenu
										}
										key={option.kind}
										onMouseDown={() => confirm(index)}
										onMouseMove={() => selectIndex(index)}
										paddingX={1}
									>
										<text
											fg={isSelected ? selectedTextColor : colors.textMuted}
											selectable={false}
										>
											{option.label}
										</text>
									</box>
								);
							})}
						</box>
						<box flexDirection="row" gap={2}>
							<text fg={colors.text}>
								⇄ <span fg={colors.textMuted}>select</span>
							</text>
							<text fg={colors.text}>
								enter <span fg={colors.textMuted}>confirm</span>
							</text>
						</box>
					</box>
				)}
			</BorderedContentBlock>
			{confirmAlways && (
				<box
					backgroundColor={colors.backgroundPanel}
					bottom={0}
					left={0}
					position="absolute"
					right={0}
					top={0}
					zIndex={10}
				>
					<ConfirmAlwaysOverlay
						colors={colors}
						layerId={confirmLayerId}
						onCancel={cancelConfirm}
						onConfirm={grantAlways}
					/>
				</box>
			)}
		</box>
	);
}

const CONFIRM_ALWAYS_OPTIONS = [
	{ kind: "always", label: "Confirm" },
	{ kind: "cancel", label: "Cancel" },
] as const;

/**
 * The overlay pushed on top of the permission block once "Always allow" is
 * armed: it owns the top keyboard layer, so enter grants, escape pops back to
 * the permission panel, and the panel's own keys stay inert underneath.
 */
function ConfirmAlwaysOverlay({
	colors,
	layerId,
	onCancel,
	onConfirm,
}: {
	colors: ThemeColors;
	layerId: string;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { isTopLayer } = useKeyboardLayer();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useLatest(selectedIndex);

	const activate = (index: number) => {
		if (index === 0) {
			onConfirm();
		} else {
			onCancel();
		}
	};

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			onCancel();
			return;
		}
		if (key.name === "left" || key.name === "up") {
			key.preventDefault();
			selectedIndexRef.current = (selectedIndexRef.current + 1) % 2;
			setSelectedIndex(selectedIndexRef.current);
			return;
		}
		if (key.name === "right" || key.name === "down" || key.name === "tab") {
			key.preventDefault();
			selectedIndexRef.current = (selectedIndexRef.current + 1) % 2;
			setSelectedIndex(selectedIndexRef.current);
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			activate(selectedIndexRef.current);
			return;
		}
	});

	return (
		<BorderedContentBlock
			borderColor={colors.error}
			colors={colors}
			contentBackgroundColor={colors.backgroundPanel}
			contentGap={1}
			marginBottom={0}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" gap={1}>
				<text fg={colors.error}>⚠</text>
				<text attributes={TextAttributes.BOLD} fg={colors.text}>
					Confirm always allow
				</text>
			</box>
			<text attributes={TextAttributes.BOLD} fg={colors.error} wrapMode="word">
				Always allow lets this tool run without asking again.
			</text>
			<box
				alignItems="center"
				flexDirection="row"
				gap={1}
				justifyContent="space-between"
			>
				<box flexDirection="row" gap={1}>
					{CONFIRM_ALWAYS_OPTIONS.map((option, index) => {
						const isSelected = index === selectedIndex;
						const accent =
							option.kind === "always" ? colors.error : colors.warning;
						const selectedTextColor = getContrastingTextColor(accent);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
							<box
								backgroundColor={isSelected ? accent : colors.backgroundMenu}
								key={option.kind}
								onMouseDown={() => activate(index)}
								onMouseMove={() => {
									selectedIndexRef.current = index;
									setSelectedIndex(index);
								}}
								paddingX={1}
							>
								<text
									fg={isSelected ? selectedTextColor : colors.textMuted}
									selectable={false}
								>
									{option.label}
								</text>
							</box>
						);
					})}
				</box>
				<box flexDirection="row" gap={2}>
					<text fg={colors.text}>
						⇄ <span fg={colors.textMuted}>select</span>
					</text>
					<text fg={colors.text}>
						enter <span fg={colors.textMuted}>confirm</span>
					</text>
					<text fg={colors.text}>
						esc <span fg={colors.textMuted}>cancel</span>
					</text>
				</box>
			</box>
		</BorderedContentBlock>
	);
}
