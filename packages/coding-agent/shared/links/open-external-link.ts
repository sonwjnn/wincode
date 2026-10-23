import { getErrorMessage, logger } from "@wincode/utils";
import open from "open";

const SUPPORTED_PROTOCOLS = new Set(["file:", "http:", "https:"]);

export type ExternalLinkOpener = (url: string) => Promise<unknown>;

const failureListeners = new Set<() => void>();

export const subscribeLinkOpenFailures = (
	listener: () => void
): (() => void) => {
	failureListeners.add(listener);
	return () => {
		failureListeners.delete(listener);
	};
};

/**
 * Opens an external link, ignoring schemes the TUI does not own. Failures are
 * logged and published to the toast layer because the root renderer sits above
 * the React providers that can show a toast.
 */
export const openExternalLink = async (
	url: string,
	opener: ExternalLinkOpener = open
): Promise<boolean> => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
		return false;
	}
	try {
		await opener(url);
		return true;
	} catch (error) {
		logger.warn("Failed to open link.", {
			error: getErrorMessage(error, "Unknown link error."),
			url,
		});
		for (const listener of failureListeners) {
			try {
				listener();
			} catch (listenerError) {
				logger.warn("Link failure listener failed.", {
					error: getErrorMessage(listenerError, "Unknown link listener error."),
					url,
				});
			}
		}
		return false;
	}
};
