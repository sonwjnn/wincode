const HEX_COLOR_RE = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu;

const getRelativeLuminance = (backgroundColor: string): number | null => {
	const match = backgroundColor.match(HEX_COLOR_RE);
	if (!match) {
		return null;
	}

	const channels = match.slice(1).map((channel) => {
		const srgb = Number.parseInt(channel ?? "0", 16) / 255;
		return srgb <= 0.039_28 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	});

	return (
		0.2126 * (channels[0] ?? 0) +
		0.7152 * (channels[1] ?? 0) +
		0.0722 * (channels[2] ?? 0)
	);
};

export const getContrastRatio = (
	backgroundColor: string,
	textColor: "black" | "white"
): number => {
	const backgroundLuminance = getRelativeLuminance(backgroundColor);
	if (backgroundLuminance === null) {
		return 1;
	}

	const textLuminance = textColor === "black" ? 0 : 1;
	const lighter = Math.max(backgroundLuminance, textLuminance);
	const darker = Math.min(backgroundLuminance, textLuminance);
	return (lighter + 0.05) / (darker + 0.05);
};

export const getContrastingTextColor = (
	backgroundColor: string
): "black" | "white" => {
	if (getRelativeLuminance(backgroundColor) === null) {
		return "black";
	}

	return getContrastRatio(backgroundColor, "black") >=
		getContrastRatio(backgroundColor, "white")
		? "black"
		: "white";
};
