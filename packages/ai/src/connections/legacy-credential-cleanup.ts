import { connectionProviderIds } from "../catalog";
import type {
	LegacyCredentialCleanupEntry,
	SecretStore,
} from "./v2-credential-vault";
import { CredentialVaultV2 } from "./v2-credential-vault";

export type {
	LegacyCredentialBackendStatus,
	LegacyCredentialCleanupEntry,
} from "./v2-credential-vault";
export type LegacyCredentialPlatformStore = SecretStore;
export type LegacyCredentialCleanupStoreOptions = Readonly<{
	fileRoot?: string;
	secretStore?: LegacyCredentialPlatformStore;
}>;

export type LegacyCredentialCleanupStore = Readonly<{
	removeAllAndVerify(): Promise<readonly LegacyCredentialCleanupEntry[]>;
}>;

/**
 * Creates the temporary destructive capability for the final migration gate.
 * Calling this factory does not touch credential backends; cleanup runs only
 * when removeAllAndVerify is explicitly invoked.
 */
export const createLegacyCredentialCleanupStore = (
	options: LegacyCredentialCleanupStoreOptions = {}
): LegacyCredentialCleanupStore => {
	const vault = new CredentialVaultV2({
		...(options.fileRoot === undefined ? {} : { fileRoot: options.fileRoot }),
		...(options.secretStore === undefined
			? {}
			: { secretStore: options.secretStore }),
	});
	return Object.freeze({
		async removeAllAndVerify(): Promise<
			readonly LegacyCredentialCleanupEntry[]
		> {
			const entries: LegacyCredentialCleanupEntry[] = [];
			for (const providerId of connectionProviderIds) {
				try {
					entries.push(await vault.removeAndVerify(providerId));
				} catch {
					entries.push({
						providerId,
						platform: "unverified",
						file: "unverified",
					});
				}
			}
			return entries;
		},
	});
};
