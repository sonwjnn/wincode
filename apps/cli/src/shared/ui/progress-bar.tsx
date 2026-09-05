import { RGBA } from "@opentui/core";
import type { AgentId } from "@wincode/agent-core";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";

const PROGRESS_BAR_WIDTH = 12;
const PROGRESS_INTERVAL_MS = 80;
const PROGRESS_FORWARD_POSITIONS = [
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
] as const;
const PROGRESS_BACKWARD_POSITIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] as const;
const PROGRESS_HOLD_OFFSETS = [1, 2, 3, 4, 5, 6] as const;
const PROGRESS_TRAIL_BRIGHTNESSES = [1, 1.15, 0.85, 0.65, 0.48, 0.32] as const;
const PROGRESS_ACTIVE_GLYPH = "■";
const PROGRESS_INACTIVE_GLYPH = "⬝";

type ProgressDirection = "backward" | "forward";

type ProgressCell = {
	position: number;
	trailIndex: number | null;
};

const createProgressFrame = (
	headPosition: number,
	direction: ProgressDirection,
	fadeOffset = 0
): ProgressCell[] =>
	Array.from({ length: PROGRESS_BAR_WIDTH }, (_, position) => {
		const distance =
			direction === "forward"
				? headPosition - position
				: position - headPosition;
		const trailIndex = distance + fadeOffset;
		const isActive =
			distance >= 0 && trailIndex < PROGRESS_TRAIL_BRIGHTNESSES.length;

		return {
			position,
			trailIndex: isActive ? trailIndex : null,
		};
	});

const INITIAL_PROGRESS_FRAME = createProgressFrame(0, "forward");
const PROGRESS_FRAMES = [
	...PROGRESS_FORWARD_POSITIONS.map((position) =>
		createProgressFrame(position, "forward")
	),
	...PROGRESS_HOLD_OFFSETS.map((fadeOffset) =>
		createProgressFrame(PROGRESS_BAR_WIDTH - 1, "forward", fadeOffset)
	),
	...PROGRESS_BACKWARD_POSITIONS.map((position) =>
		createProgressFrame(position, "backward")
	),
	...PROGRESS_HOLD_OFFSETS.map((fadeOffset) =>
		createProgressFrame(0, "backward", fadeOffset)
	),
];

type Props = {
	agent: AgentId;
};

export function ProgressBar({ agent }: Props) {
	const { colors } = useTheme();
	const [frameIndex, setFrameIndex] = useState(0);
	const agentColor = getAgentColor(colors, agent);
	const trailColors = useMemo(() => {
		const baseColor = RGBA.fromHex(agentColor);
		return PROGRESS_TRAIL_BRIGHTNESSES.map((brightness) =>
			RGBA.fromValues(
				Math.min(1, baseColor.r * brightness),
				Math.min(1, baseColor.g * brightness),
				Math.min(1, baseColor.b * brightness),
				1
			)
		);
	}, [agentColor]);
	useEffect(() => {
		const timer = setInterval(() => {
			setFrameIndex((index) => (index + 1) % PROGRESS_FRAMES.length);
		}, PROGRESS_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);

	const frame = PROGRESS_FRAMES[frameIndex] ?? INITIAL_PROGRESS_FRAME;

	return (
		<text>
			{frame.map(({ position, trailIndex }) => (
				<span
					fg={
						trailIndex === null
							? colors.textMuted
							: (trailColors[trailIndex] ?? agentColor)
					}
					key={position}
				>
					{trailIndex === null
						? PROGRESS_INACTIVE_GLYPH
						: PROGRESS_ACTIVE_GLYPH}
				</span>
			))}
		</text>
	);
}
