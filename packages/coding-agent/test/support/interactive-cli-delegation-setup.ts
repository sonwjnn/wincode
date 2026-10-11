import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import type {
	AuthorizationByProvider,
	Connections,
} from "@wincode/ai/connections";
import * as connectionsModule from "@wincode/ai/connections";
import type { ConnectionProviderId } from "@wincode/ai/models";
import { createConfigStore } from "@/shared/config/config-store";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeModelClientRecorder,
	installFakeModelClient,
} from "@/test/support/e2e-fake-runtime";
import { createEnvironmentRestorer } from "@/test/support/environment";

const previousScrollTo = Reflect.get(globalThis, "scrollTo");
export const restoreEnvironment = createEnvironmentRestorer([
	"HOME",
	"WINCODE_E2E_HOME",
	"WINCODE_E2E_WORKSPACE",
	"WINCODE_LOCAL_DB_PATH",
	"WINCODE_MODEL_PRICING_OFFLINE",
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
process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";
process.env.WINCODE_SUBAGENTS_DB_PATH = path.join(
	testDirectory,
	"subagents.sqlite"
);
export const interactiveConfigRuntime = {
	configStore: createConfigStore({
		homeRoot: testDirectory,
	}),
	cwd: testDirectory,
	homeRoot: testDirectory,
	workspace: testDirectory,
};
setInteractiveRuntimeContext({
	args: [],
	configRuntime: interactiveConfigRuntime,
	cwd: testDirectory,
});
await fs.mkdir(testDirectory, { recursive: true });

export const recorder = createFakeModelClientRecorder();
const testConnections: Connections = {
	authorize: async <Provider extends ConnectionProviderId>(
		providerId: Provider
	): Promise<AuthorizationByProvider[Provider]> =>
		fromAny({ apiKey: `${providerId}-e2e-key`, kind: "api-key" }),
	connect: async () => undefined,
	listProviders: async () => [],
};

installFakeModelClient(recorder);
// The interactive layout builds its Connections value at module load, so its
// live binding must be spied before that layout is imported.
spyOn(connectionsModule, "createConnections").mockReturnValue(testConnections);
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

export const restoreScrollTo = (): void => {
	if (previousScrollTo === undefined) {
		Reflect.deleteProperty(globalThis, "scrollTo");
	} else {
		Reflect.set(globalThis, "scrollTo", previousScrollTo);
	}
};
