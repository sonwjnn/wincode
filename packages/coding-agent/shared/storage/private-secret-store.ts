import { withSecretFile } from "./auth-file";
import { isValidSecretKey } from "./secret-key";

export type PrivateSecretStore = Readonly<{
	delete: (key: string) => Promise<void>;
	get: (key: string) => Promise<string | undefined>;
	set: (key: string, value: string) => Promise<void>;
}>;

/** Provides owner-scoped key/value secrets over one private, locked file. */
export const createPrivateSecretStore = (
	userDataDir: string,
	filePath: string,
	secretLabel: string
): PrivateSecretStore => {
	const validateKey = (key: string): void => {
		if (!isValidSecretKey(key)) {
			throw new Error(`${secretLabel} keys must be short identifiers.`);
		}
	};
	return Object.freeze({
		delete(key) {
			validateKey(key);
			return withSecretFile(userDataDir, filePath, async (secrets, save) => {
				if (!Object.hasOwn(secrets, key)) {
					return;
				}
				delete secrets[key];
				await save();
			});
		},
		get(key) {
			validateKey(key);
			return withSecretFile(userDataDir, filePath, async (secrets) =>
				Object.hasOwn(secrets, key) ? secrets[key] : undefined
			);
		},
		set(key, value) {
			validateKey(key);
			return withSecretFile(userDataDir, filePath, async (secrets, save) => {
				Object.defineProperty(secrets, key, {
					configurable: true,
					enumerable: true,
					value,
					writable: true,
				});
				await save();
			});
		},
	});
};
