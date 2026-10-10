import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APP_DATA_DIR_NAME = "wincode";

/** Resolve the user's global Wincode configuration and preference directory. */
export const resolveUserWincodeDir = (homeRoot = os.homedir()): string =>
	path.join(homeRoot, ".wincode");

/** Resolve the OS account home without process-level HOME overrides. */
const resolveOperatingSystemHome = (): string => {
	if (process.platform === "darwin") {
		return path.join("/Users", os.userInfo().username);
	}

	if (process.platform === "win32") {
		return os.homedir();
	}

	const uid = process.getuid?.();
	const account =
		uid === undefined
			? undefined
			: fs
					.readFileSync("/etc/passwd", "utf8")
					.split("\n")
					.map((entry) => entry.split(":"))
					.find((fields) => fields[2] === String(uid));
	const home = account?.[5];
	if (home === undefined || home === "" || !path.isAbsolute(home)) {
		throw new Error("Could not resolve the operating-system account home.");
	}
	return home;
};

const resolvePlatformUserDataBase = (home: string): string => {
	if (process.platform === "darwin") {
		return path.join(home, "Library", "Application Support");
	}

	if (process.platform === "win32") {
		return path.join(home, "AppData", "Roaming");
	}

	return path.join(home, ".local", "share");
};

/** Ownership indexes must not follow process-specific data-directory overrides. */
export const resolveOperatingSystemUserDataDir = (): string =>
	path.join(
		resolvePlatformUserDataBase(resolveOperatingSystemHome()),
		APP_DATA_DIR_NAME
	);

export const resolveUserDataDir = (): string => {
	let base = resolvePlatformUserDataBase(os.homedir());
	if (process.platform === "win32") {
		base = process.env.APPDATA ?? base;
	} else if (process.platform !== "darwin") {
		base = process.env.XDG_DATA_HOME ?? base;
	}
	return path.join(base, APP_DATA_DIR_NAME);
};
