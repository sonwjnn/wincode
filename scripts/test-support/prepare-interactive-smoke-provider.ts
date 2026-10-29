import * as path from "node:path";
import { pluginSourceIdentity } from "../../packages/coding-agent/modules/plugins/loader";
import {
	createProviderSdkCredentialStore,
	pluginProviderStorageId,
} from "../../packages/coding-agent/modules/providers/provider-stores";
import { resolveUserDataDir } from "../../packages/coding-agent/shared/paths/user-data-dir";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const pluginPath = path.join(
	repositoryRoot,
	"packages/coding-agent/test/support/interactive-smoke-provider.ts"
);
const storageId = pluginProviderStorageId({
	pluginId: "interactive_smoke",
	providerId: "terminal-smoke",
	sourceIdentity: pluginSourceIdentity(pluginPath),
});
const credentialStore = createProviderSdkCredentialStore({
	userDataDir: resolveUserDataDir(),
});

await credentialStore.modify(storageId, () => ({ kind: "local-test" }));
