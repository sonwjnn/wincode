import "opentui-spinner/react";

import type { ModeType } from "@wincode/ai";
import { useTheme } from "../providers/theme";

type Props = {
	mode?: ModeType;
};

export function Spinner({ mode = "build" }: Props) {
	const { colors } = useTheme();
	const activeColor = mode === "plan" ? colors.planMode : colors.primary;

	return <spinner color={activeColor} name="aesthetic" />;
}
