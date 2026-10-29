import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";

test("legacy prompt history restores unique markers and drops ambiguous literal lookalikes", async () => {
	const directory = await fs.mkdtemp(
		path.join("/tmp", "wincode-prompt-history-")
	);
	const { db, sqlite } = createDatabase(path.join(directory, "session.sqlite"));
	const store = createDrizzleSessionStore(db);
	const token = "[Pasted ~3 lines]";
	const uniqueText = token;
	const ambiguousText = `${token} quoted before ${token}`;

	try {
		for (const text of [uniqueText, ambiguousText]) {
			await store.recordPrompt({
				files: [],
				pastedText: [{ start: 0, text: "first\nsecond\nthird", token }],
				text,
			});
		}
		const rows = sqlite
			.query("SELECT id, entry_json FROM prompt_history")
			.all() as Array<{ entry_json: string; id: number }>;
		if (rows.length !== 2) {
			throw new Error("The prompt-history fixtures were not persisted.");
		}
		for (const row of rows) {
			const entry = JSON.parse(row.entry_json) as {
				pastedText: Array<{ start?: number; text: string; token: string }>;
			};
			const [marker] = entry.pastedText;
			if (marker === undefined) {
				throw new Error("The pasted-text fixture was not persisted.");
			}
			marker.start = undefined;
			sqlite
				.query("UPDATE prompt_history SET entry_json = ? WHERE id = ?")
				.run(JSON.stringify(entry), row.id);
		}

		expect(await store.getPromptHistory()).toEqual([
			{ files: [], pastedText: [], text: ambiguousText },
			{
				files: [],
				pastedText: [{ start: 0, text: "first\nsecond\nthird", token }],
				text: uniqueText,
			},
		]);
	} finally {
		sqlite.close();
		await fs.rm(directory, { force: true, recursive: true });
	}
});
