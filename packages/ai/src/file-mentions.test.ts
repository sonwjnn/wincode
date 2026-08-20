import { describe, expect, test } from "bun:test";
import {
	expandFileMentionPartsForModel,
	restoreOriginalFileMentionParts,
} from "./file-mentions";
import type { CodingAgentUIMessage } from "./message";

const editDiff = {
	additions: 1,
	deletions: 1,
	omittedHunks: 0,
	patch: "Index: src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
	truncated: false,
};

const message = {
	id: "assistant-1",
	parts: [
		{
			input: { find: "old", path: "src/example.ts", replace: "new" },
			output: {
				editDiff,
				path: "src/example.ts",
				replacements: 1,
			},
			state: "output-available",
			toolCallId: "call-1",
			type: "tool-edit",
		},
	],
	role: "assistant",
} as never as CodingAgentUIMessage;

describe("edit display metadata model boundary", () => {
	test("strips editDiff before model messages and restores it for UI persistence", () => {
		const modelMessages = expandFileMentionPartsForModel([message]);
		const modelPart = modelMessages[0]?.parts[0];

		expect(modelPart?.type).toBe("tool-edit");
		expect(
			modelPart && "output" in modelPart ? modelPart.output : null
		).toEqual({
			path: "src/example.ts",
			replacements: 1,
		});
		expect(restoreOriginalFileMentionParts(modelMessages, [message])).toEqual([
			message,
		]);
	});
});
