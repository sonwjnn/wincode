import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import type {
	AuthorizationByProvider,
	Connections,
} from "@wincode/ai/connections";
import { connectionProviderDisplayNames } from "@wincode/ai/connections";
import type { ConnectionProviderId } from "@wincode/ai/models";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import {
	createFakeModelClientModule,
	createFakeModelClientRecorder,
} from "@/test/support/e2e-fake-runtime";

const previousScrollTo = Reflect.get(globalThis, "scrollTo");
const previousEnvironment = {
	HOME: process.env.HOME,
	WINCODE_E2E_HOME: process.env.WINCODE_E2E_HOME,
	WINCODE_E2E_WORKSPACE: process.env.WINCODE_E2E_WORKSPACE,
	WINCODE_LOCAL_DB_PATH: process.env.WINCODE_LOCAL_DB_PATH,
	WINCODE_MODEL_PRICING_OFFLINE: process.env.WINCODE_MODEL_PRICING_OFFLINE,
};

export const testDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-interactive-cli-e2e-")
);
process.env.HOME = testDirectory;
process.env.WINCODE_E2E_HOME = testDirectory;
process.env.WINCODE_E2E_WORKSPACE = testDirectory;
process.env.WINCODE_LOCAL_DB_PATH = path.join(
	testDirectory,
	"conversation.sqlite"
);
process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";
setInteractiveRuntimeContext({ args: [], cwd: testDirectory });

export const recorder = createFakeModelClientRecorder();
const testConnections: Connections = {
	authorize: async <Provider extends ConnectionProviderId>(
		providerId: Provider
	): Promise<AuthorizationByProvider[Provider]> =>
		fromAny({ apiKey: `${providerId}-e2e-key`, kind: "api-key" }),
	connect: async () => undefined,
	listProviders: async () => [],
};

await mock.module("@wincode/ai/model-client", () =>
	createFakeModelClientModule(recorder)
);
await mock.module("@wincode/ai/connections", () => ({
	connectionProviderDisplayNames,
	createConnections: () => testConnections,
}));
await Bun.write(
	path.join(testDirectory, ".wincode", "wincode.jsonc"),
	`{
	"agents": {
		"scout": { "description": "Inspect and report findings", "role": "subagent" }
	}
}`
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

export const restoreEnvironment = (): void => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
};
