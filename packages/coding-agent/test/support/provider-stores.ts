import type { CredentialStore } from "@wincode/ai";

export const createInMemoryCredentialStore = (
	credentials: Map<string, unknown>,
	beforeCredentialWrite?: (
		providerId: string,
		credential: unknown
	) => Promise<void>
): CredentialStore => ({
	delete: (providerId) => {
		credentials.delete(providerId);
	},
	get: (providerId) => credentials.get(providerId),
	set: (providerId, credential) => {
		if (beforeCredentialWrite === undefined) {
			credentials.set(providerId, credential);
			return;
		}
		return beforeCredentialWrite(providerId, credential).then(() => {
			credentials.set(providerId, credential);
		});
	},
});
