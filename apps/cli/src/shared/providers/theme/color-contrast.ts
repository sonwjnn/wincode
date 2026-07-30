const HEX_COLOR_RE = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/iu;

export const getContrastingTextColor = (backgroundColor: string): string => {
	const match = backgroundColor.match(HEX_COLOR_RE);
	if (!match) {
		return "black";
	}

	const red = Number.parseInt(match[1] ?? "0", 16);
	const green = Number.parseInt(match[2] ?? "0", 16);
	const blue = Number.parseInt(match[3] ?? "0", 16);
	const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

	return luminance > 0.55 ? "black" : "white";
};
