import { describe, expect, test } from "bun:test";
import { writeClipboard } from "./clipboard";

const renderer = (result: boolean) => ({ copyToClipboardOSC52: () => result });

describe("writeClipboard", () => {
	test("skips native when OSC52 succeeds", async () => {
		let calls = 0;
		expect(
			await writeClipboard(
				renderer(true),
				"text",
				async () => {
					calls += 1;
					return 0;
				},
				"darwin"
			)
		).toBe(true);
		expect(calls).toBe(0);
	});

	test("uses macOS native fallback", async () => {
		const commands: string[][] = [];
		expect(
			await writeClipboard(
				renderer(false),
				"text",
				async (command) => {
					commands.push(command);
					return 0;
				},
				"darwin"
			)
		).toBe(true);
		expect(commands).toEqual([["pbcopy"]]);
	});

	test("falls through Linux missing and failed commands", async () => {
		const commands: string[][] = [];
		expect(
			await writeClipboard(
				renderer(false),
				"text",
				async (command) => {
					commands.push(command);
					if (commands.length === 1) {
						throw new Error("missing");
					}
					if (commands.length === 2) {
						return 1;
					}
					return 0;
				},
				"linux"
			)
		).toBe(true);
		expect(commands.map(([command]) => command)).toEqual([
			"wl-copy",
			"xclip",
			"xsel",
		]);
	});

	test("uses Windows PowerShell and reports unsupported failure", async () => {
		const commands: string[][] = [];
		expect(
			await writeClipboard(
				renderer(false),
				"text",
				async (command) => {
					commands.push(command);
					return 0;
				},
				"win32"
			)
		).toBe(true);
		expect(commands[0]).toEqual([
			"powershell",
			"-NoProfile",
			"-Command",
			"Set-Clipboard",
		]);
		expect(
			await writeClipboard(renderer(false), "text", async () => 1, "freebsd")
		).toBe(false);
	});
});
