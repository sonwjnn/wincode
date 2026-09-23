export type ClipboardImage = {
	bytes: Uint8Array;
	mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
};

export type ClipboardImageResult = ClipboardImage | { unavailable: true };

type CommandResult = { exitCode: number; stdout: Uint8Array };

export type ClipboardImageDeps = {
	platform?: NodeJS.Platform;
	environment?: Record<string, string | undefined>;
	run: (command: string, args: string[]) => Promise<CommandResult>;
	readFile: (path: string) => Promise<Uint8Array>;
	stat?: (path: string) => Promise<{ isFile: () => boolean }>;
	removeFile: (path: string) => Promise<void>;
	temporaryPath: () => string;
};

const unavailable = (): ClipboardImageResult => ({ unavailable: true });
const QUOTED_PATH = /^(?:'([^']*)'|"((?:\\.|[^"\\])*)")$/;
const ESCAPED_PATH_CHARACTER = /\\([\\ ])/g;
const ESCAPED_QUOTE_CHARACTER = /\\(.)/g;

export function imageFromBytes(bytes: Uint8Array): ClipboardImageResult {
	if (
		bytes.length >= 8 &&
		bytes
			.slice(0, 8)
			.every(
				(value, index) =>
					value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]
			)
	) {
		return { bytes, mediaType: "image/png" };
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return { bytes, mediaType: "image/jpeg" };
	}
	if (
		bytes.length >= 6 &&
		new TextDecoder().decode(bytes.slice(0, 6)) === "GIF8"
	) {
		return { bytes, mediaType: "image/gif" };
	}
	if (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
	) {
		return { bytes, mediaType: "image/webp" };
	}
	return unavailable();
}

const png = (bytes: Uint8Array): ClipboardImageResult => imageFromBytes(bytes);

export function decodeImagePath(text: string): string | null {
	const value = text.trim();
	if (!value || value.includes("\n")) {
		return null;
	}
	const unquoted = value.replace(
		QUOTED_PATH,
		(_, single, double) =>
			single ?? double.replaceAll(ESCAPED_QUOTE_CHARACTER, "$1")
	);
	if (unquoted.startsWith("file://")) {
		try {
			const url = new URL(unquoted);
			if (url.protocol !== "file:" || url.hostname) {
				return null;
			}
			return decodeURIComponent(url.pathname);
		} catch {
			return null;
		}
	}
	const path = unquoted.replaceAll(ESCAPED_PATH_CHARACTER, "$1");
	return path.startsWith("/") ||
		path.startsWith("./") ||
		path.startsWith("../") ||
		path.startsWith("~/")
		? path
		: null;
}

export async function readImagePath(
	text: string,
	deps: Pick<ClipboardImageDeps, "readFile" | "stat">
): Promise<ClipboardImageResult> {
	const path = decodeImagePath(text);
	if (!(path && deps.stat)) {
		return unavailable();
	}
	try {
		if (!(await deps.stat(path)).isFile()) {
			return unavailable();
		}
		return imageFromBytes(await deps.readFile(path));
	} catch {
		return unavailable();
	}
}

const decodeBase64 = (bytes: Uint8Array): Uint8Array =>
	Uint8Array.from(
		Buffer.from(new TextDecoder().decode(bytes).trim(), "base64")
	);

async function macClipboard(
	deps: ClipboardImageDeps
): Promise<ClipboardImageResult> {
	const path = deps.temporaryPath();
	try {
		const result = await deps.run("osascript", [
			"-e",
			'on run argv\nset outputPath to item 1 of argv\ntry\nset imageData to the clipboard as «class PNGf»\nset fileRef to open for access outputPath with write permission\nset eof fileRef to 0\nwrite imageData to fileRef\nclose access fileRef\nreturn "ok"\non error\ntry\nclose access outputPath\nend try\nreturn "unavailable"\nend try\nend run',
			path,
		]);
		if (
			result.exitCode !== 0 ||
			new TextDecoder().decode(result.stdout).trim() !== "ok"
		) {
			return unavailable();
		}
		return png(await deps.readFile(path));
	} catch {
		return unavailable();
	} finally {
		await deps.removeFile(path).catch(() => undefined);
	}
}

async function powershellClipboard(
	deps: ClipboardImageDeps,
	command: string
): Promise<ClipboardImageResult> {
	try {
		const result = await deps.run(command, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[Console]::OutputEncoding = [Text.Encoding]::ASCII; Add-Type -AssemblyName PresentationCore; $image = [System.Windows.Clipboard]::GetImage(); if ($null -eq $image) { exit 3 }; $stream = New-Object IO.MemoryStream; $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder; $frame = [Windows.Media.Imaging.BitmapFrame]::Create($image); $encoder.Frames.Add($frame); $encoder.Save($stream); [Convert]::ToBase64String($stream.ToArray())",
		]);
		return result.exitCode === 0
			? png(decodeBase64(result.stdout))
			: unavailable();
	} catch {
		return unavailable();
	}
}

export async function readClipboardImage(
	deps: ClipboardImageDeps
): Promise<ClipboardImageResult> {
	const platform = deps.platform ?? process.platform;
	if (platform === "darwin") {
		return macClipboard(deps);
	}
	if (platform === "win32") {
		return powershellClipboard(deps, "powershell.exe");
	}
	if (platform === "linux") {
		if (deps.environment?.WSL_INTEROP) {
			return powershellClipboard(deps, "powershell.exe");
		}
		for (const args of [
			["--type", "image/png", "--no-newline"],
			["-selection", "clipboard", "-t", "image/png", "-o"],
		]) {
			try {
				const result = await deps.run(
					args[0] === "--type" ? "wl-paste" : "xclip",
					args
				);
				if (result.exitCode === 0) {
					return png(result.stdout);
				}
			} catch {
				// Missing clipboard command is an expected unavailable result.
			}
		}
	}
	return unavailable();
}
