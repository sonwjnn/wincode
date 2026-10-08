import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ThemeColors } from "@/shared/providers/theme/themes";
import { usePluginStatusPanels } from "./use-plugin-status-panels";

const statusColor = (
	status: "idle" | "pending" | "success" | "warning" | "error",
	colors: ThemeColors
): string => {
	if (status === "success") {
		return colors.success;
	}
	if (status === "warning" || status === "error") {
		return colors.error;
	}
	return colors.textMuted;
};

export const PluginStatusSidebar = () => {
	const { colors } = useTheme();
	const panels = usePluginStatusPanels();
	if (panels.length === 0) {
		return null;
	}
	return (
		<box flexDirection="column" gap={1}>
			{panels.map(({ panel, snapshot }) => (
				<box flexDirection="column" key={`${panel.pluginId}:${panel.id}`}>
					<text attributes={TextAttributes.BOLD} fg={colors.text}>
						{panel.title}
					</text>
					{snapshot.items.length === 0 ? (
						<text fg={colors.textMuted}>
							{panel.emptyText ?? "No status items"}
						</text>
					) : (
						snapshot.items.map((item) => (
							<box flexDirection="row" gap={1} key={item.id} width="100%">
								<text fg={statusColor(item.status, colors)}>•</text>
								<box flexGrow={1} overflow="hidden">
									<text fg={colors.text} wrapMode="none">
										{item.label}
									</text>
								</box>
								<text
									fg={statusColor(item.status, colors)}
									flexShrink={0}
									wrapMode="none"
								>
									{item.status}
								</text>
							</box>
						))
					)}
				</box>
			))}
		</box>
	);
};
