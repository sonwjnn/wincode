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

	test("does not match inside a name or against a description", () => {
		expect(filterCommandItems(ITEMS, "eview")).toEqual([]);
		expect(filterCommandItems(ITEMS, "conventional")).toEqual([]);
	});
});
