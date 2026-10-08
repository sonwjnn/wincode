import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePluginStatusPanels } from "./use-plugin-status-panels";

export const PluginStatusIndicator = () => {
	const { colors } = useTheme();
	const panels = usePluginStatusPanels().filter(
		({ panel }) => panel.indicatorLabel !== undefined
	);

	if (panels.length === 0) {
		return null;
	}

	return (
		<box flexDirection="row" flexShrink={0} gap={2}>
			{panels.map(({ panel, snapshot }) => {
				let color = colors.textMuted;
				if (snapshot.status === "error" || snapshot.status === "warning") {
					color = colors.error;
				} else if (snapshot.status === "success") {
					color = colors.success;
				}
				return (
					<box
						flexDirection="row"
						flexShrink={0}
						gap={1}
						key={`${panel.pluginId}:${panel.id}`}
					>
						<text fg={color}>⊙</text>
						<text fg={colors.text}>{snapshot.summary ?? panel.title}</text>
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							{panel.indicatorLabel}
						</text>
					</box>
				);
			})}
		</box>
	);
};
