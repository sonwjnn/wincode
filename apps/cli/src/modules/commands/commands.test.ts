import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands";

describe("CommandSpec registry", () => {
	test("has 14 commands with discriminated kinds", () => {
		expect(COMMANDS).toHaveLength(14);
	});

	test("does not expose billing commands", () => {
		expect(COMMANDS.some(({ value }) => value === "/upgrade")).toBe(false);
		expect(COMMANDS.some(({ value }) => value === "/usage")).toBe(false);
	});

	test("/exit is kind: 'exit'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/exit");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("exit");
	});

	test("/new is kind: 'new'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/new");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("new");
	});

	test("/agents is kind: 'agents'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/agents");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("agents");
	});
	test("/settings is kind: 'settings'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/settings");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("settings");
	});

	test("/models is kind: 'models'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/models");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("models");
	});

	test("/variants is kind: 'variants'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/variants");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("variants");
	});

	test("/skills is kind: 'skills'", () => {
		const cmd = COMMANDS.find((command) => command.value === "/skills");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("skills");
	});

	test("/themes is kind: 'dialog'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/themes");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("dialog");
		if (cmd?.kind === "dialog") {
			expect(cmd.dialogKey).toBe("theme");
		}
	});

	test("/mcps is kind: 'dialog'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/mcps");
		expect(cmd).toBeDefined();
		expect(cmd?.name).toBe("mcps");
		expect(cmd?.description).toBe("Enable, disable, and inspect MCP servers");
		expect(cmd?.kind).toBe("dialog");
		if (cmd?.kind === "dialog") {
			expect(cmd.dialogKey).toBe("mcps");
		}
	});

	test("/permissions is kind: 'dialog'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/permissions");
		expect(cmd).toBeDefined();
		expect(cmd?.name).toBe("permissions");
		expect(cmd?.kind).toBe("dialog");
		if (cmd?.kind === "dialog") {
			expect(cmd.dialogKey).toBe("permissions");
		}
	});

	test("/connect is kind: 'connect'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/connect");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("connect");
	});
});
