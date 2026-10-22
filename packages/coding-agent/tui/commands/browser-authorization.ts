import type {
	ClipboardWriteOutcome,
	ClipboardWriter,
} from "@/shared/clipboard";

/**
 * Copies the authorization URL and maps any clipboard failure to the message
 * the connect dialog renders, keeping that user-facing text in one place.
 */
export async function copyBrowserAuthorizationUrl(
	clipboard: ClipboardWriter,
	url: string
): Promise<void> {
	let outcome: ClipboardWriteOutcome;
	try {
		outcome = await clipboard.write(url);
	} catch (error) {
		throw new Error("Failed to copy URL.", { cause: error });
	}
	if (outcome !== "copied") {
		throw new Error("Failed to copy URL.");
	}
}
