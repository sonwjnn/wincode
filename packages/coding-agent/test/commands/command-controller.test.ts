import { expect, test } from "bun:test";
import { createCommandController } from "@/modules/commands/command-controller";

test("puts the skill namespace chooser first in slash suggestions", () => {
	const controller = createCommandController({
		customCommands: [],
		discoverCustomCommands: async () => [],
		discoverSkills: async () => [],
		executeCommand: () => undefined,
		onError: () => undefined,
		skills: [
			{
				body: "",
				description: "Review changes",
				filePath: "review/SKILL.md",
				name: "review",
				scope: "project",
			},
		],
	});

	expect(controller.getSuggestions("").items[0]?.label).toBe("skill:");
});
