import { useConfig } from "@/shared/config/config-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";

export const PROJECT_TRUST_WARNING =
	"This project is not trusted. Project .wincode resources and packages are ignored. Use /trust to save a trust decision, then restart wincode.";

export function ProjectTrustWarning() {
	const config = useConfig();
	const { colors } = useTheme();
	if ((config.untrustedProjectRoots ?? []).length === 0) {
		return null;
	}
	return (
		<box flexShrink={0} paddingX={2} width="100%">
			<text fg={colors.warning} wrapMode="word">
				{PROJECT_TRUST_WARNING}
			</text>
		</box>
	);
}
