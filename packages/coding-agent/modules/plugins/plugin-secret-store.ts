import * as path from "node:path";
import { createUserSecretStore } from "@/shared/storage/user-secret-store";

const SERVICE_NAME = "wincode-plugin";
const pluginIdPattern = /^[a-z0-9_]+$/u;
const secretKeyPattern = /^[a-zA-Z0-9_.:-]{1,128}$/u;

type BunSecretStore = Partial<typeof Bun.secrets>;

export type PluginSecretStore = Readonly<{
	delete: (key: string) => Promise<void>;
	get: (key: string) => Promise<string | undefined>;
	set: (key: string, value: string) => Promise<void>;
}>;

/** Creates a user-scoped secret store owned by one Plugin identity. */
export const createPluginSecretStore = (
	pluginId: string,
	userDataDir: string,
	providedPlatformStore?: BunSecretStore | null
): PluginSecretStore => {
	if (!pluginIdPattern.test(pluginId)) {
		throw new Error("Invalid Plugin Identifier for secret storage.");
	}
	const validateKey = (key: string): void => {
		if (!secretKeyPattern.test(key)) {
			throw new Error("Plugin secret keys must be short identifiers.");
		}
	};
	return createUserSecretStore({
		accountPrefix: pluginId,
		filePath: path.join(userDataDir, "plugin-secrets", `${pluginId}.json`),
		platformService: SERVICE_NAME,
		platformStore: providedPlatformStore,
		secretLabel: "Plugin secret",
		validateKey,
	});
};
