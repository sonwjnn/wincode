import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import {
	canonicalizeExternalPath,
	createPermissionService,
	createToolPermission,
	expandHomeInPath,
	externalParentDirectoryGlob,
} from "./index";

describe("skill permission action", () => {
	test("defaults to allow when no rule exists", () => {
		const permission = createToolPermission();
		expect(permission.decide("skill", "review")).toBe("allow");
	});

	test("applies scalar and resource-glob rules with last match winning", () => {
		const permission = createToolPermission({
			skill: {
				"internal-*": "deny",
				"internal-audit": "allow",
			},
		});
		expect(permission.decide("skill", "review")).toBe("allow");
		expect(permission.decide("skill", "internal-secret")).toBe("deny");
		expect(permission.decide("skill", "internal-audit")).toBe("allow");
	});

	test("scalar rule applies to every Skill", () => {
		const permission = createToolPermission({ skill: "ask" });
		expect(permission.decide("skill", "any-skill")).toBe("ask");
	});
});

describe("external_directory permission action", () => {
	test("defaults to ask", () => {
		const permission = createToolPermission();
		expect(permission.decide("external_directory", "/Users/x/file.txt")).toBe(
			"ask"
		);
	});

	test("scalar allow applies to every external path", () => {
		const permission = createToolPermission({ external_directory: "allow" });
		expect(permission.decide("external_directory", "/Users/x/file.txt")).toBe(
			"allow"
		);
	});

	test("expands ~ and $HOME in configured patterns", () => {
		const home = homedir();
		const permission = createToolPermission({
			external_directory: {
				"~/shared/**": "allow",
				"$HOME/private/**": "deny",
			},
		});
		expect(
			permission.decide("external_directory", `${home}/shared/a/b.txt`)
		).toBe("allow");
		expect(
			permission.decide("external_directory", `${home}/private/keys.txt`)
		).toBe("deny");
		expect(permission.decide("external_directory", `${home}/other/x.txt`)).toBe(
			"ask"
		);
	});
});

describe("expandHomeInPath", () => {
	test("expands ~, ~/, and $HOME forms", () => {
		expect(expandHomeInPath("~", "/home/u")).toBe("/home/u");
		expect(expandHomeInPath("~/shared", "/home/u")).toBe("/home/u/shared");
		expect(expandHomeInPath("$HOME/x", "/home/u")).toBe("/home/u/x");
		expect(expandHomeInPath("/plain/path", "/home/u")).toBe("/plain/path");
	});
});

describe("canonicalizeExternalPath", () => {
	test("resolves symlinks in the nearest existing ancestor", async () => {
		const base = await mkdtemp(join(tmpdir(), "wincode-ext-canon-"));
		const realBase = await realpath(base);
		const real = join(realBase, "real");
		const linked = join(realBase, "linked");
		await mkdir(real);
		await symlink(real, linked, "dir");
		const canonical = await canonicalizeExternalPath(
			join(linked, "deep/file.txt"),
			realBase
		);
		expect(canonical).toBe(join(real, "deep/file.txt"));
	});

	test("keeps a not-yet-existing suffix verbatim", async () => {
		const base = await realpath(
			await mkdtemp(join(tmpdir(), "wincode-ext-canon-new-"))
		);
		const canonical = await canonicalizeExternalPath(
			join(base, "new-dir/file.txt"),
			base
		);
		expect(canonical).toBe(join(base, "new-dir/file.txt"));
	});

	test("expands ~ against the real home", async () => {
		const canonical = await canonicalizeExternalPath(
			"~/nonexistent-wincode-path",
			"/tmp"
		);
		expect(canonical.startsWith(homedir())).toBe(true);
	});
});

describe("external_directory grants", () => {
	test("parent-directory globs satisfy sibling and nested resources", () => {
		const service = createPermissionService();
		service.grant(
			"external_directory",
			externalParentDirectoryGlob("/a/b/c.txt")
		);
		expect(service.isGranted("external_directory", "/a/b/c.txt")).toBe(true);
		expect(service.isGranted("external_directory", "/a/b/d.txt")).toBe(true);
		expect(service.isGranted("external_directory", "/a/b/d/e.txt")).toBe(true);
		expect(service.isGranted("external_directory", "/a/other/x.txt")).toBe(
			false
		);
		expect(service.isGranted("read", "/a/b/c.txt")).toBe(false);
	});

	test("exact grants still match exactly", () => {
		const service = createPermissionService();
		service.grant("external_directory", "/a/b/c.txt");
		expect(service.isGranted("external_directory", "/a/b/c.txt")).toBe(true);
		expect(service.isGranted("external_directory", "/a/b/d.txt")).toBe(false);
	});
});

describe("workspace boundary", () => {
	test("inside-workspace paths never consult external_directory", async () => {
		const dir = await realpath(
			await mkdtemp(join(tmpdir(), "wincode-ext-inside-"))
		);
		await writeFile(join(dir, "file.txt"), "x");
		const sandbox = createWorkspaceSandbox(dir);
		const inside = await sandbox.resolveExistingPath("file.txt");
		expect(inside).toBe(join(dir, "file.txt"));
	});
});
