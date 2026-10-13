import { useConfig } from "@/shared/config/config-provider";
import { InlineNotice } from "@/shared/ui/inline-notice";

export const PROJECT_TRUST_NOTICE_MESSAGE =
	"This project is not trusted. Project .wincode resources and packages are ignored. Use /trust to save a trust decision, then restart Wincode.";

/** Warns while protected project resources are skipped because the project is untrusted. */
export function ProjectTrustNotice() {
	const config = useConfig();
	if ((config.untrustedProjectRoots ?? []).length === 0) {
		return null;
	}
	return (
		<InlineNotice variant="warning">
			{PROJECT_TRUST_NOTICE_MESSAGE}
		</InlineNotice>
	);
}
