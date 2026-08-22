import type { AgentId } from "@wincode/ai";
import { useEffect, useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type Props = {
	agent: AgentId;
};

export function Spinner({ agent }: Props) {
	const { colors } = useTheme();
	const [frameIndex, setFrameIndex] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrameIndex((index) => (index + 1) % SPINNER_FRAMES.length);
		}, SPINNER_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);

	return (
		<text fg={getAgentColor(colors, agent)}>
			{SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0]}
		</text>
	);
}
