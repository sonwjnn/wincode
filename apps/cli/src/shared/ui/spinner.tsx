import "opentui-spinner/react";

import type { AgentId } from "@wincode/ai";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";

type Props = {
	agent: AgentId;
};

export function Spinner({ agent }: Props) {
	const { colors } = useTheme();

	return <spinner color={getAgentColor(colors, agent)} name="material" />;
}
