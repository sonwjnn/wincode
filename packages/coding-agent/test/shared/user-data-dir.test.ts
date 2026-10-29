import { expect, test } from "bun:test";
import * as path from "node:path";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";

test("user data resolves under the supplied isolated platform environment", () => {
	const home = path.join("/tmp", "wincode-smoke-home");
	const appData = path.join(home, "appdata");
	const xdgData = path.join(home, "xdg-data");
	const environment = {
		APPDATA: appData,
		HOME: home,
		USERPROFILE: home,
		XDG_DATA_HOME: xdgData,
	};
	let expectedBase = xdgData;
	if (process.platform === "darwin") {
		expectedBase = path.join(home, "Library", "Application Support");
	} else if (process.platform === "win32") {
		expectedBase = appData;
	}

	expect(resolveUserDataDir(environment, home)).toBe(
		path.join(expectedBase, "wincode")
	);
});
