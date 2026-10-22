import { isNull } from "@wincode/utils";

const HEX_COLOR_RE = /^#?([\da-f]{3,4}|[\da-f]{6}(?:[\da-f]{2})?)$/iu;

type ParsedColor = {
	channels: readonly [number, number, number];
	alpha: number;
};

const parseColor = (color: string): ParsedColor | null => {
	const match = color.match(HEX_COLOR_RE);
	if (!match) {
		return null;
	}

	const hex = match[1] ?? "";
	const expanded =
		hex.length <= 4
			? [...hex].map((value) => `${value}${value}`).join("")
			: hex;
	return {
		alpha: Number.parseInt(expanded.slice(6) || "ff", 16) / 255,
		channels: [
			Number.parseInt(expanded.slice(0, 2), 16),
			Number.parseInt(expanded.slice(2, 4), 16),
			Number.parseInt(expanded.slice(4, 6), 16),
		],
	};
};

const getLuminance = (channels: readonly number[]): number => {
	const luminanceChannels = channels.map((channel) => {
		const srgb = channel / 255;
		return srgb <= 0.039_28 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	});
	return (
		0.2126 * (luminanceChannels[0] ?? 0) +
		0.7152 * (luminanceChannels[1] ?? 0) +
		0.0722 * (luminanceChannels[2] ?? 0)
	);
};

const getRelativeLuminance = (backgroundColor: string): number | null => {
	const parsed = parseColor(backgroundColor);
	if (isNull(parsed)) {
		return null;
	}
	return getLuminance(parsed.channels.map((channel) => channel * parsed.alpha));
};

export const getContrastRatio = (
	backgroundColor: string,
	textColor: "black" | "white"
): number => {
	const backgroundLuminance = getRelativeLuminance(backgroundColor);
	if (isNull(backgroundLuminance)) {
		return 1;
	}

	const textLuminance = textColor === "black" ? 0 : 1;
	const lighter = Math.max(backgroundLuminance, textLuminance);
	const darker = Math.min(backgroundLuminance, textLuminance);
	return (lighter + 0.05) / (darker + 0.05);
};

export const getColorContrastRatio = (
	backgroundColor: string,
	foregroundColor: string
): number => {
	const background = parseColor(backgroundColor);
	const foreground = parseColor(foregroundColor);
	if (isNull(background) || isNull(foreground)) {
		return 1;
	}

	const backgroundChannels = background.channels.map(
		(channel) => channel * background.alpha
	);
	const foregroundChannels = foreground.channels.map(
		(channel, index) =>
			channel * foreground.alpha +
			(backgroundChannels[index] ?? 0) * (1 - foreground.alpha)
	);
	const backgroundLuminance = getLuminance(backgroundChannels);
	const foregroundLuminance = getLuminance(foregroundChannels);
	const lighter = Math.max(backgroundLuminance, foregroundLuminance);
	const darker = Math.min(backgroundLuminance, foregroundLuminance);
	return (lighter + 0.05) / (darker + 0.05);
};

export const getContrastingTextColor = (
	backgroundColor: string
): "black" | "white" => {
	if (isNull(getRelativeLuminance(backgroundColor))) {
		return "black";
	}

	return getContrastRatio(backgroundColor, "black") >=
		getContrastRatio(backgroundColor, "white")
		? "black"
		: "white";
};
