import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./commands";

describe("CommandSpec registry", () => {
	test("has 9 commands with discriminated kinds", () => {
		expect(COMMANDS).toHaveLength(9);
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

	test("/agents is kind: 'mode'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/agents");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("mode");
	});

	test("/models is kind: 'models'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/models");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("models");
	});

	test("/theme is kind: 'dialog'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/theme");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("dialog");
		if (cmd?.kind === "dialog") {
			expect(cmd.dialogKey).toBe("theme");
		}
	});

	test("/connect is kind: 'connect'", () => {
		const cmd = COMMANDS.find((c) => c.value === "/connect");
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("connect");
	});
});
