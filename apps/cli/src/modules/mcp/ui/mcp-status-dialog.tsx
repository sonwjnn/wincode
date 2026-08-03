import { TextAttributes } from "@opentui/core";
import { useCallback, useMemo } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import { useMcp } from "../context/mcp-provider";
import type { McpServerState, McpServerStatus } from "../registry";

export const MCP_LOCAL_WARNING =
	"Local commands run with your OS permissions and inherited environment.";

export type StatusRowFormat = {
	error?: string;
	reconnectable: boolean;
	server: string;
	state: McpServerState;
	toolCount: number;
	transport: McpServerStatus["transport"];
	warning?: string;
};

// Registry errors are already sanitized against each server's config, but the
// dialog must never render config, env, headers, or urls even if a future code
// path leaks them into a status error. Scrub URL-like and credential-like
// tokens as defense in depth.
const URL_LIKE_PATTERN = /https?:\/\/[^\s,;]+/gi;
const CREDENTIAL_LIKE_PATTERN =
	/(api[_-]?key|authorization|bearer|token)\s*[=:]\s*[^\s,;"']+/gi;

export function sanitizeStatusError(error: string): string {
	return error
		.replace(URL_LIKE_PATTERN, "[redacted]")
		.replace(CREDENTIAL_LIKE_PATTERN, "$1=[redacted]");
}

export function formatStatusRow(status: McpServerStatus): StatusRowFormat {
	const row: StatusRowFormat = {
		reconnectable: status.state === "degraded" || status.state === "failed",
		server: status.name,
		state: status.state,
		toolCount: status.toolCount,
		transport: status.transport,
	};
	if (status.transport === "local") {
		row.warning = MCP_LOCAL_WARNING;
	}
	if (status.error !== undefined && status.error.length > 0) {
		row.error = sanitizeStatusError(status.error);
	}
	return row;
}

/**
 * Pure status dialog. Lists MCP servers with their transport, state, and tool
 * count; local rows surface the OS-permissions warning and failed/degraded rows
 * can be reconnected with enter. Only fields derived from McpServerStatus are
 * rendered, so no config, env, headers, or urls can appear.
 */
export function McpStatusDialogContent() {
	const { reconnect, statuses } = useMcp();
	const { colors } = useTheme();

	useDialogEscape();

	const rows = useMemo(
		() => statuses.map((status) => formatStatusRow(status)),
		[statuses]
	);
	const hasLocalRows = rows.some((row) => row.transport === "local");
	const hasReconnectableRows = rows.some((row) => row.reconnectable);

	const handleSelect = useCallback(
		(row: StatusRowFormat) => {
			if (row.reconnectable) {
				void reconnect(row.server);
			}
		},
		[reconnect]
	);

	const filterFn = useCallback((row: StatusRowFormat, query: string) => {
		const q = query.toLowerCase();
		return `${row.server} ${row.state} ${row.transport}`
			.toLowerCase()
			.includes(q);
	}, []);

	const stateColorFor = (row: StatusRowFormat, fallback: string): string => {
		switch (row.state) {
			case "failed":
				return colors.error;
			case "connected":
				return colors.success;
			case "degraded":
				return colors.info;
			default:
				return fallback;
		}
	};

	return (
		<SearchListDialogWrapper<StatusRowFormat>
			emptyText="No MCP servers"
			filterFn={filterFn}
			footer={
				hasLocalRows || hasReconnectableRows ? (
					<box flexDirection="column" gap={0} marginX={4}>
						{hasLocalRows && (
							<text
								attributes={TextAttributes.DIM}
								fg={colors.textMuted}
								wrapMode="word"
							>
								{MCP_LOCAL_WARNING}
							</text>
						)}
						{hasReconnectableRows && (
							<box flexDirection="row" gap={1} height={1}>
								<text fg={colors.text}>enter</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									reconnect failed server
								</text>
							</box>
						)}
					</box>
				) : undefined
			}
			getKey={(row) => row.server}
			isItemSelectable={(row) => row.reconnectable}
			items={rows}
			onSelect={handleSelect}
			placeholder="Search MCP servers"
			renderItem={(row, isSelected) => {
				const selectedTextColor = getContrastingTextColor(colors.selection);
				const primaryTextColor = isSelected ? selectedTextColor : colors.text;
				const secondaryTextColor = isSelected
					? selectedTextColor
					: colors.textMuted;
				const stateColor = stateColorFor(row, secondaryTextColor);

				return (
					<SelectableDialogItem>
						<box flexDirection="row" flexGrow={1} gap={2} overflow="hidden">
							<box flexShrink={0}>
								<text fg={primaryTextColor} selectable={false} wrapMode="none">
									{row.server}
								</text>
							</box>
							<box flexGrow={1} />
							<text
								attributes={TextAttributes.DIM}
								fg={secondaryTextColor}
								selectable={false}
							>
								{row.transport}
							</text>
							<text fg={stateColor} selectable={false}>
								{row.state}
							</text>
							<text
								attributes={TextAttributes.DIM}
								fg={secondaryTextColor}
								selectable={false}
							>
								{row.toolCount} tools
							</text>
							{row.reconnectable && (
								<text fg={stateColor} selectable={false}>
									reconnect
								</text>
							)}
							{row.error !== undefined && (
								<text
									attributes={TextAttributes.DIM}
									fg={secondaryTextColor}
									selectable={false}
									wrapMode="none"
								>
									{row.error}
								</text>
							)}
						</box>
					</SelectableDialogItem>
				);
			}}
		/>
	);
}
