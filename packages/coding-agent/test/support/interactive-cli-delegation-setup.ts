import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createConfigStore } from "@/shared/config/config-store";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeProviderRecorder,
	createInstalledFakeProviderCollection,
	installFakeProviderRecorder,
} from "@/test/support/e2e-fake-runtime";
import { createEnvironmentRestorer } from "@/test/support/environment";

const previousScrollTo = Reflect.get(globalThis, "scrollTo");
export const restoreEnvironment = createEnvironmentRestorer([
	"HOME",
	"WINCODE_E2E_HOME",
	"WINCODE_E2E_WORKSPACE",
	"WINCODE_LOCAL_DB_PATH",
	"WINCODE_SUBAGENTS_DB_PATH",
]);

export const testDirectory = path.join(
	os.tmpdir(),
	`wincode-interactive-cli-e2e-${crypto.randomUUID()}`
);
process.env.HOME = testDirectory;
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
process.env.WINCODE_LOCAL_DB_PATH = path.join(
	testDirectory,
	"conversation.sqlite"
);
process.env.WINCODE_SUBAGENTS_DB_PATH = path.join(
	testDirectory,
	"subagents.sqlite"
);
const homeDirSpy = spyOn(os, "homedir").mockReturnValue(testDirectory);
await Bun.write(
	path.join(testDirectory, ".wincode", "project-trust.json"),
	JSON.stringify({
		decisions: [
			{ directory: await fs.realpath(process.cwd()), decision: "trust" },
		],
		version: 1,
	})
);

export const interactiveConfigRuntime = {
	configStore: createConfigStore({
		homeRoot: testDirectory,
	}),
	cwd: testDirectory,
	homeRoot: testDirectory,
	workspace: testDirectory,
};
export const recorder = createFakeProviderRecorder();
installFakeProviderRecorder(recorder);
setInteractiveRuntimeContext({
	args: [],
	configRuntime: interactiveConfigRuntime,
	cwd: testDirectory,
	createProviderCollection: () => createInstalledFakeProviderCollection(),
});

await Bun.write(
	path.join(testDirectory, ".wincode", "wincode.jsonc"),
	`{
	"agents": {
		"scout": { "description": "Inspect and report findings", "role": "subagent" }
	}
}`
);
await Bun.write(
	path.join(testDirectory, "wincode.jsonc"),
	'{"permission":{"plugin:subagents:delegate":"allow","submit_result":"allow"}}'
);

export const cleanupTestDirectory = (): Promise<void> =>
	fs.rm(testDirectory, { force: true, recursive: true });

export const restoreHomeDirectory = (): void => homeDirSpy.mockRestore();

export const restoreScrollTo = (): void => {
	if (previousScrollTo === undefined) {
		Reflect.deleteProperty(globalThis, "scrollTo");
	} else {
		Reflect.set(globalThis, "scrollTo", previousScrollTo);
	}
};
