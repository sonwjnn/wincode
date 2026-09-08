import type { useRenderer } from "@opentui/react";

export type ClipboardRenderer = Pick<
	ReturnType<typeof useRenderer>,
	"copyToClipboardOSC52"
>;
export type ClipboardSpawn = (
	command: string[],
	text: string
) => Promise<number>;

const nativeCommands: Record<string, string[][]> = {
	darwin: [["pbcopy"]],
	linux: [
		["wl-copy"],
		["xclip", "-selection", "clipboard"],
		["xsel", "--clipboard", "--input"],
	],
	win32: [["powershell", "-NoProfile", "-Command", "Set-Clipboard"]],
};

const defaultSpawn: ClipboardSpawn = async (command, text) => {
	const bun = globalThis as typeof globalThis & {
		Bun: {
			spawn: (
				command: string[],
				options: { stdin: Blob }
			) => { exited: Promise<number> };
		};
	};
	const process = bun.Bun.spawn(command, { stdin: new Blob([text]) });
	return await process.exited;
};

export async function writeClipboard(
	renderer: ClipboardRenderer,
	text: string,
	spawn: ClipboardSpawn = defaultSpawn,
	platform = process.platform
): Promise<boolean> {
	let copied = false;
	try {
		copied = renderer.copyToClipboardOSC52(text);
	} catch {
		// Renderer clipboard capability can be unavailable.
	}

	if (copied) {
		return true;
	}

	for (const command of nativeCommands[platform] ?? []) {
		try {
			if ((await spawn(command, text)) === 0) {
				copied = true;
				break;
			}
		} catch {
			// Missing native clipboard command is a normal fallback case.
		}
	}
	return copied;
}

export function clipboardCommands(platform: string): string[][] {
	return nativeCommands[platform] ?? [];
}
