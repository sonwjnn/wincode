import "opentui-spinner/react";

import { defaultMode, type ModeType } from "@wincode/ai";
import { useTheme } from "../providers/theme";

type Props = {
	mode?: ModeType;
};

export function Spinner({ mode = defaultMode.value }: Props) {
	const { colors } = useTheme();
	const activeColor = colors.mode[mode];

	return <spinner color={activeColor} name="aesthetic" />;
}
