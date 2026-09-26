import { describe, expect, test } from "bun:test";
import {
	type CommandItem,
	createSkillCommandSpecs,
	filterCommandItems,
	getCommandLabel,
} from "@/modules/commands/command-item";

const MODELS: CommandItem = {
	description: "Select AI model for generation",
	kind: "models",
	name: "models",
	value: "/models",
};

const GIT_COMMIT: CommandItem = {
	description: "Commit with conventional commits",
	kind: "custom",
	name: "git-commit",
	template: "Commit the staged changes.",
	value: "/git-commit",
};

const SKILLS = createSkillCommandSpecs([
	{ description: "Reviews implementation", name: "review" },
	{ description: "Audits dependencies", name: "audit" },
]);

const ITEMS: CommandItem[] = [MODELS, GIT_COMMIT, ...SKILLS];

const labels = (items: CommandItem[]) => items.map(getCommandLabel);

describe("getCommandLabel", () => {
	test("keeps skill rows namespaced and every other source bare", () => {
		expect(labels(ITEMS)).toEqual([
			"models",
			"git-commit",
			"skill:audit",
			"skill:review",
		]);
	});
});

describe("filterCommandItems", () => {
	test("returns every row in source order for an empty query", () => {
		expect(labels(filterCommandItems(ITEMS, ""))).toEqual(labels(ITEMS));
	});

	test("matches rows by label prefix, ignoring case", () => {
		expect(labels(filterCommandItems(ITEMS, "MOD"))).toEqual(["models"]);
		expect(labels(filterCommandItems(ITEMS, "skill:re"))).toEqual([
			"skill:review",
		]);
	});

	test("matches a namespaced row by its bare skill name", () => {
		expect(labels(filterCommandItems(ITEMS, "rev"))).toEqual(["skill:review"]);
		expect(labels(filterCommandItems(ITEMS, "skill:"))).toEqual([
			"skill:audit",
			"skill:review",
		]);
	});

	test("fuzzy-matches skill names with or without the namespace", () => {
		const sdkSkill = createSkillCommandSpecs([
			{ description: "SDK helpers", name: "ai-sdk" },
		]);

		for (const query of ["sdk", "skill:sdk"]) {
			expect(labels(filterCommandItems(sdkSkill, query))).toEqual([
				"skill:ai-sdk",
			]);
		}

		expect(labels(filterCommandItems(sdkSkill, "skill:"))).toEqual([
			"skill:ai-sdk",
		]);
	});

	test("matches skill names with an ordered subsequence inside a word", () => {
		expect(labels(filterCommandItems(SKILLS, "riew"))).toEqual([
			"skill:review",
		]);
	});

	test("does not return every skill for punctuation-only queries", () => {
		expect(labels(filterCommandItems(SKILLS, "!!!"))).toEqual([]);
	});

	test("fuzzy-matches skill names when adjacent letters and numbers are swapped", () => {
		const modelSkill = createSkillCommandSpecs([
			{ description: "Model helpers", name: "model-4o" },
		]);

		for (const query of ["modelo4", "skill:modelo4"]) {
			expect(labels(filterCommandItems(modelSkill, query))).toEqual([
				"skill:model-4o",
			]);
		}
	});

	test("keeps prefix matching for commands and ignores descriptions", () => {
		expect(filterCommandItems([GIT_COMMIT], "commit")).toEqual([]);
		expect(filterCommandItems(ITEMS, "conventional")).toEqual([]);
	});
});
