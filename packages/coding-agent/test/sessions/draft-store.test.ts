import { describe, expect, test } from "bun:test";
import {
	restoreComposerDraft,
	writeComposerDraft,
} from "@/modules/sessions/hooks/input-controller/draft-store";

describe("composer draft store", () => {
	test("restores plain text without markers whose payloads cannot be rebuilt", () => {
		writeComposerDraft(
			"draft-store-tokens",
			"keep [Image 1] mid [Pasted ~3 lines] end"
		);
		expect(restoreComposerDraft("draft-store-tokens")).toBe("keep  mid  end");

		writeComposerDraft("draft-store-tokens", "");
		expect(restoreComposerDraft("draft-store-tokens")).toBe("");
	});

	test("keeps at most 64 drafts and evicts the oldest key", () => {
		for (let index = 0; index < 65; index += 1) {
			writeComposerDraft(`draft-store-cap-${index}`, `text ${index}`);
		}
		expect(restoreComposerDraft("draft-store-cap-0")).toBe("");
		expect(restoreComposerDraft("draft-store-cap-64")).toBe("text 64");

		for (let index = 1; index < 65; index += 1) {
			writeComposerDraft(`draft-store-cap-${index}`, "");
		}
	});
});
