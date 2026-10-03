import { describe, expect, test } from "bun:test";
import {
	type CreateCommandControllerOptions,
	createCommandController,
} from "@/modules/commands/command-controller";
import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import type { Skill } from "@/modules/skills";

const REVIEW_SKILL: Skill = {
	body: "Review changes.",
	description: "Review changes",
	filePath: "/tmp/review/SKILL.md",
	name: "review",
	scope: "project",
};

const AUDIT_SKILL: Skill = {
	body: "Audit dependencies.",
	description: "Audit dependencies",
	filePath: "/tmp/audit/SKILL.md",
	name: "audit",
	scope: "project",
};

const COMMIT_COMMAND: CustomCommandSpec = {
	description: "Commit staged changes",
	kind: "custom",
	name: "git-commit",
	template: "Commit the staged changes.",
	value: "/git-commit",
};

const createController = (
	overrides: Partial<CreateCommandControllerOptions> = {}
) =>
	createCommandController({
		customCommands: [],
		discoverCustomCommands: async () => [],
		discoverSkills: async () => [],
		executeCommand: () => undefined,
		onError: () => undefined,
		skills: [REVIEW_SKILL, AUDIT_SKILL],
		...overrides,
	});

describe("getSuggestions", () => {
	test("puts the skill namespace chooser first in root suggestions", () => {
		const controller = createController();

		expect(controller.getSuggestions("").items[0]?.label).toBe("skill:");
	});

	test("offers only Skills on a prose trigger", () => {
		const controller = createController({ customCommands: [COMMIT_COMMAND] });

		expect(
			controller
				.getSuggestions("re", "skill")
				.items.map((suggestion) => suggestion.label)
		).toEqual(["skill:review"]);
		expect(
			controller.getSuggestions("", "skill").items.map(({ label }) => label)
		).toEqual(["skill:audit", "skill:review"]);
	});

	test("keeps Built-in and Custom Commands in root suggestions", () => {
		const controller = createController({ customCommands: [COMMIT_COMMAND] });

		expect(
			controller.getSuggestions("co", "root").items.map(({ label }) => label)
		).toEqual(["compact", "connect"]);
		expect(
			controller.getSuggestions("git", "root").items.map(({ label }) => label)
		).toEqual(["git-commit"]);
	});
});

describe("select", () => {
	test("returns a Skill intent with the namespaced invocation", () => {
		const controller = createController();
		const skill = controller
			.getSuggestions("", "skill")
			.items.find(({ label }) => label === "skill:review");
		if (skill === undefined) {
			throw new Error("expected the review Skill row");
		}

		expect(controller.select(skill.id, "enter")).toEqual({
			intent: { kind: "skill", name: "review" },
			invocation: "/skill:review",
			kind: "insert",
			reopen: false,
		});
	});

	test("returns a Custom Command intent for its bare invocation", () => {
		const controller = createController({ customCommands: [COMMIT_COMMAND] });
		const rows = controller.getSuggestions("git", "root").items;
		const command = rows.find(({ label }) => label === "git-commit");
		if (command === undefined) {
			throw new Error("expected the custom command row");
		}

		expect(controller.select(command.id, "enter")).toEqual({
			intent: { kind: "custom", name: "git-commit" },
			invocation: "/git-commit",
			kind: "insert",
			reopen: false,
		});
	});

	test("keeps the skill chooser reopenable without an intent", () => {
		const controller = createController();
		const [chooser] = controller.getSuggestions("").items;
		if (chooser === undefined) {
			throw new Error("expected the skill chooser row");
		}

		expect(controller.select(chooser.id, "enter")).toEqual({
			invocation: "/skill:",
			kind: "insert",
			reopen: true,
		});
	});

	test("tracks a Tab-completed Built-in so its trailing text stays arguments", () => {
		const controller = createController();
		const rows = controller.getSuggestions("compact", "root").items;
		const compact = rows.find(({ label }) => label === "compact");
		if (compact === undefined) {
			throw new Error("expected the compact row");
		}

		expect(controller.select(compact.id, "tab")).toEqual({
			intent: { kind: "builtin", name: "compact" },
			invocation: "/compact",
			kind: "insert",
			reopen: false,
		});
	});

	test("executes a Built-in selected with Enter", () => {
		const commands: string[] = [];
		const controller = createController({
			executeCommand: (command) => {
				commands.push(command.name);
			},
		});
		const rows = controller.getSuggestions("settings", "root").items;
		const settings = rows.find(({ label }) => label === "settings");
		if (settings === undefined) {
			throw new Error("expected the settings row");
		}

		const selection = controller.select(settings.id, "enter");
		if (selection?.kind !== "execute") {
			throw new Error("expected an execute selection");
		}
		void selection.execute();

		expect(commands).toEqual(["settings"]);
	});
});
