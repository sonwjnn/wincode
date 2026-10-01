import type { CliRenderer } from "@opentui/core";
import {
	type ClipboardSpawn,
	writeClipboard,
} from "@/shared/clipboard/clipboard";

export async function copyBrowserAuthorizationUrl(
	renderer: Pick<CliRenderer, "copyToClipboardOSC52">,
	url: string,
	spawnProcess?: ClipboardSpawn
): Promise<void> {
	if (await writeClipboard(renderer, url, spawnProcess)) {
		return;
	}
	if (process.platform !== "darwin") {
		throw new Error("Clipboard is not supported by this terminal.");
	}
	throw new Error("Failed to copy URL.");
}
