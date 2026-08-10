import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useWatchedPermissionService } from "../permission-service-provider";

// Row 0 is always the auto-approval toggle; grant rows follow it. Selection is a
// flat index over [toggle, ...grants] so up/down move through the whole list.
const AUTO_ROW_INDEX = 0;

/**
 * The `/permissions` control surface. Lists the process-lifetime temporary
 * grants by exact action/resource and the workspace auto-approval state.
 * Enter on the top row toggles auto approval; enter on a grant row revokes it,
 * which changes later authorization behavior for that exact action/resource.
 */
export function PermissionsDialogContent() {
	const service = useWatchedPermissionService();
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	const grants = service.listGrants();
	const autoApproval = service.isAutoApproval();
	const rowCount = grants.length + 1;

	const [selectedIndex, setSelectedIndex] = useState(AUTO_ROW_INDEX);
	const selectedIndexRef = useRef(AUTO_ROW_INDEX);

	useEffect(() => {
		// Clamp the selection when the list shrinks (a grant was revoked) so it
		// never points past the last row.
		if (selectedIndexRef.current > rowCount - 1) {
			const clamped = rowCount - 1;
			selectedIndexRef.current = clamped;
			setSelectedIndex(clamped);
		}
	}, [rowCount]);

	useDialogEscape();

	const moveSelection = (delta: number) => {
		const next = Math.min(
			rowCount - 1,
			Math.max(0, selectedIndexRef.current + delta)
		);
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	};

	const activate = (index: number) => {
		if (index === AUTO_ROW_INDEX) {
			service.setAutoApproval(!service.isAutoApproval());
			return;
		}
		const grant = grants[index - 1];
		if (grant !== undefined) {
			service.revoke(grant.action, grant.resource);
		}
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
			activate(selectedIndexRef.current);
		}
	});

	const autoSelected = selectedIndex === AUTO_ROW_INDEX;

	return (
		<box flexDirection="column" gap={1} marginX={4}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
			<text
				attributes={autoSelected ? TextAttributes.BOLD : undefined}
				fg={autoSelected ? colors.primary : colors.text}
				onMouseDown={() => activate(AUTO_ROW_INDEX)}
			>
				{`${autoSelected ? "> " : "  "}Auto approval: ${autoApproval ? "on" : "off"}`}
			</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				Temporary grants (this workspace, this session)
			</text>
			{grants.length === 0 ? (
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					No temporary grants
				</text>
			) : (
				grants.map((grant, index) => {
					const rowIndex = index + 1;
					const isSelected = selectedIndex === rowIndex;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events.
						<text
							attributes={isSelected ? TextAttributes.BOLD : undefined}
							fg={isSelected ? colors.primary : colors.text}
							key={`${grant.action} ${grant.resource}`}
							onMouseDown={() => activate(rowIndex)}
						>
							{`${isSelected ? "> " : "  "}${grant.action}  ${grant.resource}`}
						</text>
					);
				})
			)}
			<box flexDirection="row" gap={2} height={1} marginTop={1}>
				<text fg={colors.text}>enter</text>
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{autoSelected ? "toggle auto approval" : "revoke grant"}
				</text>
			</box>
		</box>
	);
}
