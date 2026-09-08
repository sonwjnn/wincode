const HEX_COLOR_RE = /^#?([\da-f]{3,4}|[\da-f]{6}(?:[\da-f]{2})?)$/iu;

const getRelativeLuminance = (backgroundColor: string): number | null => {
	const match = backgroundColor.match(HEX_COLOR_RE);
	if (!match) {
		return null;
	}

	const hex = match[1] ?? "";
	const expanded =
		hex.length <= 4
			? [...hex].map((value) => `${value}${value}`).join("")
			: hex;
	const alpha = Number.parseInt(expanded.slice(6) || "ff", 16) / 255;
	const channels = [
		expanded.slice(0, 2),
		expanded.slice(2, 4),
		expanded.slice(4, 6),
	].map((channel) => {
		const srgb = Number.parseInt(channel ?? "0", 16) / 255;
		const composited = srgb * alpha;
		return composited <= 0.039_28
			? composited / 12.92
			: ((composited + 0.055) / 1.055) ** 2.4;
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
