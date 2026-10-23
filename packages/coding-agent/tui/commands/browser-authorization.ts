import type {
	ClipboardWriteOutcome,
	ClipboardWriter,
} from "@/shared/clipboard";

const copyFailure = (cause?: unknown): Error =>
	new Error("Failed to copy URL.", cause === undefined ? undefined : { cause });

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
		throw copyFailure(error);
	}
	if (outcome !== "copied") {
		throw copyFailure();
	}
}
