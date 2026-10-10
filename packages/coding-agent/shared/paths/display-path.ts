import * as os from "node:os";

/** Abbreviates paths under the user's home directory for display. */
export const shortenHomePath = (
	displayPath: string,
	homeDirectory = os.homedir()
): string => {
	if (displayPath === homeDirectory) {
		return "~";
	}

	const separatorAfterHome = displayPath[homeDirectory.length];
	return displayPath.startsWith(homeDirectory) &&
		(separatorAfterHome === "/" || separatorAfterHome === "\\")
		? `~${displayPath.slice(homeDirectory.length)}`
		: displayPath;
};
