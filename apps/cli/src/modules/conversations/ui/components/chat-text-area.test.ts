import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "../../../../shared/terminal/keyboard-layer/constants";

describe("ChatTextArea", () => {
	test("binds enter to submit and modified enter to newline", () => {
		expect(CHAT_TEXT_AREA_KEY_BINDINGS).toEqual([
			{ action: "submit", name: "return" },
			{ action: "submit", name: "enter" },
			{ action: "newline", name: "return", shift: true },
			{ action: "newline", name: "enter", shift: true },
			{ action: "newline", ctrl: true, name: "return" },
			{ action: "newline", ctrl: true, name: "enter" },
		]);
	});

	test("does not bind shift tab to model cycling", async () => {
		const [textAreaSource, promptConfigSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL(
					"../../../../modules/prompt-settings/context/prompt-config-provider.tsx",
					import.meta.url
				),
				"utf8"
			),
		]);

		expect(textAreaSource).not.toContain("cycleModel");
		expect(textAreaSource).not.toContain("key.shift");
		expect(promptConfigSource).not.toContain("cycleModel");
	});

	test("syncs textarea text only for programmatic edits", async () => {
		const textAreaSource = await readFile(
			new URL("./chat-text-area.tsx", import.meta.url),
			"utf8"
		);

		expect(textAreaSource).toContain("lastTextSyncRevisionRef");
		expect(textAreaSource).toContain("state.textSyncRevision");
		expect(textAreaSource).not.toContain("textarea.plainText !== state.text");
	});
});
