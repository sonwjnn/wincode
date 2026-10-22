import type { ClipboardWriter } from "@/shared/clipboard";

/**
 * Copies the authorization URL and maps any clipboard failure to the message
 * the connect dialog renders, keeping that user-facing text in one place.
 */
export async function copyBrowserAuthorizationUrl(
	clipboard: ClipboardWriter,
	url: string
): Promise<void> {
	try {
		if (!(await clipboard.write(url))) {
			throw new Error("Clipboard write was skipped.");
		}
	} catch (error) {
		throw new Error("Failed to copy URL.", { cause: error });
	}
}
