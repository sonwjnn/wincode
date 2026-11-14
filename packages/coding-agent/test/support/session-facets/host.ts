import type { SessionCapabilities } from "../../../modules/sessions/host/types";
import type { SessionStorage } from "../../../modules/sessions/storage/session-storage";

const storageKey = Symbol.for("wincode.test.session-storage");

type CapabilitiesWithStorage = SessionCapabilities & {
	[storageKey]?: SessionStorage;
};

/**
 * Binds the storage a test opened beside the capabilities it reads, so every
 * `openHost` in that test names it without a second module-level variable. The
 * key is a symbol, so a spread of these capabilities carries it.
 */
export const withSessionStorage = <Capabilities extends SessionCapabilities>(
	capabilities: Capabilities,
	storage: SessionStorage
): Capabilities => {
	(capabilities as CapabilitiesWithStorage)[storageKey] = storage;
	return capabilities;
};

export const sessionStorageOf = (
	capabilities: SessionCapabilities
): SessionStorage => {
	const storage = (capabilities as CapabilitiesWithStorage)[storageKey];
	if (storage === undefined) {
		throw new Error(
			"Test Session capabilities were created without Session storage."
		);
	}
	return storage;
};
