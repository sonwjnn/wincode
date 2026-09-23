import { homedir } from "node:os";
import { join } from "node:path";

const APP_DATA_DIR_NAME = "wincode";

export const resolveUserDataDir = (): string => {
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", APP_DATA_DIR_NAME);
	}

	if (process.platform === "win32") {
		return join(
			process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
			APP_DATA_DIR_NAME
		);
	}

	return join(
		process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
		APP_DATA_DIR_NAME
	);
};
