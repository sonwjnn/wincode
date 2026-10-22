import type { ClipboardWriter } from "@/shared/clipboard";

export async function copyBrowserAuthorizationUrl(
	clipboard: ClipboardWriter,
	url: string
): Promise<void> {
	try {
		await clipboard.write(url);
	} catch (error) {
		throw new Error("Failed to copy URL.", { cause: error });
	}
}
