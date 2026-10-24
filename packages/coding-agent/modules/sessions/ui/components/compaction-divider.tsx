import { TextAttributes } from "@opentui/core";
import { formatModelTokenCount } from "@wincode/ai";
import { useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	type SessionCompaction,
	withoutFileOperationsSection,
} from "../../compaction";

const TRIGGER_LABELS: Record<SessionCompaction["trigger"], string> = {
	manual: "manual",
	threshold: "automatic",
	overflow: "overflow recovery",
};

export const formatCompactionDivider = (
	entry: Pick<
		SessionCompaction,
		"estimatedTokensAfter" | "tokensBefore" | "trigger"
	>
): string =>
	`Compacted (${TRIGGER_LABELS[entry.trigger]}) · ${formatModelTokenCount(entry.tokensBefore)}→${formatModelTokenCount(entry.estimatedTokensAfter)} tokens`;

export function CompactionDivider({ entry }: { entry: SessionCompaction }) {
	const { colors } = useTheme();
	const [expanded, setExpanded] = useState(false);
	const fileOperations = entry.summary.fileOperations;
	const summaryText = withoutFileOperationsSection(
		entry.summary.text,
		fileOperations
	);
	const toggleExpanded = () => setExpanded((value) => !value);
	const onKeyDown = (key: { name: string; preventDefault: () => void }) => {
		if (key.name !== "enter" && key.name !== "return" && key.name !== "space") {
			return;
		}
		key.preventDefault();
		toggleExpanded();
	};
	return (
		<box flexDirection="column" gap={1} width="100%">
			<box alignItems="center" flexDirection="row" gap={1} width="100%">
				<box
					border={["bottom"]}
					borderColor={colors.textMuted}
					flexGrow={1}
					height={1}
				/>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse and keyboard events. */}
				<box
					focusable
					id={`compaction-divider-${entry.id}`}
					onKeyDown={onKeyDown}
					onMouseDown={toggleExpanded}
				>
					<text
						attributes={TextAttributes.DIM}
						fg={colors.textMuted}
						selectable={false}
					>
						<span>{formatCompactionDivider(entry)}</span>
						<span>
							{expanded
								? " ▾ (Enter/Space to collapse)"
								: " ▸ (Enter/Space to expand)"}
						</span>
					</text>
				</box>
				<box
					border={["bottom"]}
					borderColor={colors.textMuted}
					flexGrow={1}
					height={1}
				/>
			</box>
			{expanded ? (
				<box
					border={["left"]}
					borderColor={colors.textMuted}
					flexDirection="column"
					gap={1}
					paddingLeft={1}
				>
					{summaryText.length > 0 ? (
						<text fg={colors.text}>{summaryText}</text>
					) : null}
					{fileOperations === undefined ? null : (
						<box flexDirection="column" gap={1}>
							<text fg={colors.textMuted}>
								Tracked file snapshot · up to 200 paths per group; Read and
								Modified may overlap. Derived from completed tool outputs
								through this compaction, not the current workspace.
							</text>
							{fileOperations.read.length > 0 ? (
								<box flexDirection="column">
									<text attributes={TextAttributes.BOLD} fg={colors.text}>
										Read
									</text>
									{fileOperations.read.map((path) => (
										<text fg={colors.text} key={`read:${path}`}>
											{path}
										</text>
									))}
								</box>
							) : null}
							{fileOperations.modified.length > 0 ? (
								<box flexDirection="column">
									<text attributes={TextAttributes.BOLD} fg={colors.text}>
										Modified
									</text>
									{fileOperations.modified.map((path) => (
										<text fg={colors.text} key={`modified:${path}`}>
											{path}
										</text>
									))}
								</box>
							) : null}
						</box>
					)}
				</box>
			) : null}
		</box>
	);
}
