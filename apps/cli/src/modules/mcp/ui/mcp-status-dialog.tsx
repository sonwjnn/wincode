import { TextAttributes } from "@opentui/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { redactSensitiveText } from "@/shared/display-sanitize";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import { useMcp } from "../context/mcp-provider";
import type { McpServerState, McpServerStatus } from "../registry";

export const MCP_LOCAL_WARNING =
	"Local commands run with your OS permissions and inherited environment.";

export type StatusRowFormat = {
	enabled: boolean;
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
// tokens as defense in depth, preserving the key name for readable output.
export function sanitizeStatusError(error: string): string {
	return redactSensitiveText(error, { keepKey: true, redactUrls: true });
}

export function formatStatusRow(status: McpServerStatus): StatusRowFormat {
	const row: StatusRowFormat = {
		enabled: status.state !== "disabled",
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

type McpStatusRowProps = {
	isLoading: boolean;
	isSelected: boolean;
	row: StatusRowFormat;
};

function McpStatusRow({ isLoading, isSelected, row }: McpStatusRowProps) {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const primaryTextColor = isSelected ? selectedTextColor : colors.text;
	const secondaryTextColor = isSelected ? selectedTextColor : colors.textMuted;
	let connectionColor = colors.textMuted;
	if (isSelected) {
		connectionColor = selectedTextColor;
	} else if (row.state === "connected") {
		connectionColor = colors.success;
	} else if (row.reconnectable) {
		connectionColor = colors.error;
	}
	const stateLabel = isLoading ? "loading..." : row.state;
	const showStateLabel = isLoading || row.state !== "connected";
	let connectionLabel = "Disabled";
	if (isLoading) {
		connectionLabel = "Loading...";
	} else if (row.state === "connected") {
		connectionLabel = "Connected";
	} else if (row.reconnectable) {
		connectionLabel = isSelected ? "Reconnect" : "Failed";
	}
	const indicator = row.state === "connected" && !isLoading ? "✓" : "○";

	return (
		<SelectableDialogItem>
			<box
				flexDirection="row"
				flexGrow={1}
				gap={1}
				marginRight={3}
				overflow="hidden"
			>
				<box flexDirection="row" flexShrink={0} gap={1}>
					<text
						attributes={isSelected ? TextAttributes.BOLD : undefined}
						fg={primaryTextColor}
						selectable={false}
						wrapMode="none"
					>
						{row.server}
					</text>
					{showStateLabel ? (
						<text
							attributes={TextAttributes.DIM}
							fg={secondaryTextColor}
							selectable={false}
						>
							{stateLabel}
						</text>
					) : null}
				</box>
				<box flexGrow={1} />
				<box flexDirection="row" flexShrink={0} gap={1}>
					<text fg={connectionColor} selectable={false}>
						{connectionLabel}
					</text>
					<text fg={connectionColor} selectable={false}>
						{indicator}
					</text>
				</box>
			</box>
		</SelectableDialogItem>
	);
}

/**
 * Lists MCP servers and lets the highlighted server be enabled or disabled at
 * runtime with Space. Only fields derived from McpServerStatus are rendered, so
 * no config, environment, headers, or URLs can appear.
 */
export function McpStatusDialogContent() {
	const { initialize, reconnect, statuses, toggle } = useMcp();
	const loadingServersRef = useRef(new Set<string>());
	const mountedRef = useRef(true);
	const [loadingServers, setLoadingServers] = useState<ReadonlySet<string>>(
		() => new Set()
	);

	useDialogEscape();
	useEffect(() => {
		mountedRef.current = true;
		void initialize().catch(() => undefined);
		return () => {
			mountedRef.current = false;
		};
	}, [initialize]);

	const rows = useMemo(
		() => statuses.map((status) => formatStatusRow(status)),
		[statuses]
	);
	const handleAction = useCallback(
		(row: StatusRowFormat) => {
			const serverName = row.server;
			if (
				row.state === "connecting" ||
				loadingServersRef.current.has(serverName)
			) {
				return;
			}
			loadingServersRef.current.add(serverName);
			setLoadingServers(new Set(loadingServersRef.current));
			const action = row.reconnectable
				? reconnect(serverName)
				: toggle(serverName);
			void action
				.finally(() => {
					loadingServersRef.current.delete(serverName);
					if (mountedRef.current) {
						setLoadingServers(new Set(loadingServersRef.current));
					}
				})
				.catch(() => undefined);
		},
		[reconnect, toggle]
	);

	const filterFn = useCallback((row: StatusRowFormat, query: string) => {
		const q = query.toLowerCase();
		return `${row.server} ${row.state} ${row.transport}`
			.toLowerCase()
			.includes(q);
	}, []);

	return (
		<SearchListDialogWrapper<StatusRowFormat>
			emptyText="No MCPs"
			filterFn={filterFn}
			footer={
				<box flexDirection="row" gap={2} height={1} marginX={4}>
					<DialogFooterHint label="toggle/reconnect" shortcut="space" />
				</box>
			}
			getKey={(row) => row.server}
			items={rows}
			onKey={(key, highlightedRow) => {
				if (key.name !== "space") {
					return false;
				}
				if (highlightedRow !== undefined) {
					handleAction(highlightedRow);
				}
				return true;
			}}
			onSelect={() => undefined}
			placeholder="Search"
			renderItem={(row, isSelected) => (
				<McpStatusRow
					isLoading={
						loadingServers.has(row.server) || row.state === "connecting"
					}
					isSelected={isSelected}
					row={row}
				/>
			)}
		/>
	);
}
