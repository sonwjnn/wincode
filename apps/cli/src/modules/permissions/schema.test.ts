import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/shared/config/filesystem-test-utils";
import { resolveTopLevelPermission } from "./schema";

const CONFIG_ROOT = "/home/user/.config/wincode";
const HOME_ROOT = "/home/user";

const fileSystem = (files: Record<string, string>) => ({
	readFile: async (file: string): Promise<string> => {
		const value = files[file];
		if (value === undefined) {
			const error = new Error("missing") as Error & { code: string };
			error.code = "ENOENT";
			throw error;
		}
		return value;
	},
});

const loadSnapshot = async (
	workspaceFile?: string
): Promise<ConfigSnapshot> => {
	const workspace = "/workspace";
	const files: Record<string, string> = {
		[`${CONFIG_ROOT}/wincode.json`]: "{}",
		[`${HOME_ROOT}/.wincode/wincode.json`]: "{}",
		[`${workspace}/wincode.json`]: workspaceFile ?? "{}",
	};
	const store = createConfigStore({
		configRoot: CONFIG_ROOT,
		fs: fileSystem(files),
		homeRoot: HOME_ROOT,
	});
	return store.getSnapshot(workspace);
};

describe("resolveTopLevelPermission", () => {
	test("returns undefined when no permission section is configured", async () => {
		const snapshot = await loadSnapshot('{"settings":{"format":"json"}}');
		expect(resolveTopLevelPermission(snapshot)).toBeUndefined();
	});

	test("parses a scalar action decision", async () => {
		const snapshot = await loadSnapshot('{"permission":{"read":"ask"}}');
		expect(resolveTopLevelPermission(snapshot)).toEqual({ read: "ask" });
	});

	test("parses an action resource map", async () => {
		const snapshot = await loadSnapshot(
			'{"permission":{"read":{".env":"deny","**":"allow"}}}'
		);
		expect(resolveTopLevelPermission(snapshot)).toEqual({
			read: { ".env": "deny", "**": "allow" },
		});
	});

	test("merges global and project permission sections with project precedence", async () => {
		const workspace = "/workspace";
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: fileSystem({
				[`${CONFIG_ROOT}/wincode.json`]:
					'{"permission":{"read":{".env":"deny","**":"ask"}}}',
				[`${HOME_ROOT}/.wincode/wincode.json`]: "{}",
				[`${workspace}/wincode.json`]:
					'{"permission":{"read":{".env":"allow"}}}',
			}),
			homeRoot: HOME_ROOT,
		});
		const snapshot = await store.getSnapshot(workspace);
		expect(resolveTopLevelPermission(snapshot)).toEqual({
			read: { ".env": "allow", "**": "ask" },
		});
	});

	test("returns undefined for an invalid decision value", async () => {
		const snapshot = await loadSnapshot(
			'{"permission":{"read":{"**.env":"always"}}}'
		);
		expect(resolveTopLevelPermission(snapshot)).toBeUndefined();
	});

	test("returns undefined for a non-object permission section", async () => {
		const snapshot = await loadSnapshot('{"permission":["read","ask"]}');
		expect(resolveTopLevelPermission(snapshot)).toBeUndefined();
	});
});

describe("resolveTopLevelPermission with real files", () => {
	test("reads permission from a real JSONC workspace config", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "wincode-permission-"));
		await writeFixture(
			`${workspace}/wincode.jsonc`,
			'{// ask before env reads\n"permission":{"read":{".env":"ask"}},}'
		);
		const store = createConfigStore({
			configRoot: CONFIG_ROOT,
			fs: {
				readFile: (file: string) => readFile(file, "utf8"),
			},
			homeRoot: HOME_ROOT,
		});
		const snapshot = await store.getSnapshot(workspace);
		expect(resolveTopLevelPermission(snapshot)).toEqual({
			read: { ".env": "ask" },
		});
	});
});
