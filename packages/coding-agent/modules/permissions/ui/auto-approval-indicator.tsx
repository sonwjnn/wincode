import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useWatchedPermissionService } from "../permission-service-provider";

/**
 * The status-bar `auto` indicator. Renders nothing while auto approval is off and
 * a visible `auto` chip (with a leading separator) while it is enabled, staying
 * in sync with the shared Permission service through the watched subscription.
 */
export function AutoApprovalIndicator() {
	const service = useWatchedPermissionService();
	const { colors } = useTheme();
	if (!service.isAutoApproval()) {
		return null;
	}
	return (
		<>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text attributes={TextAttributes.BOLD} fg={colors.info}>
				auto
			</text>
		</>
	);
}
