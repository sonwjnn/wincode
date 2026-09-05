import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSandbox } from "@wincode/coding-tools/workspace";
import { canonicalizeResource } from "./canonical";

describe("canonicalizeResource", () => {
	test("resolves to the workspace-relative POSIX path of the real file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		await writeFile(join(dir, ".env"), "SECRET=1");
		const sandbox = createWorkspaceSandbox(dir);

		expect(await canonicalizeResource(".env", sandbox)).toBe(".env");
		expect(await canonicalizeResource("./.env", sandbox)).toBe(".env");
	});

	test("normalizes dot segments after sandbox resolution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		await writeFile(join(dir, ".env"), "SECRET=1");
		const sandbox = createWorkspaceSandbox(dir);

		expect(await canonicalizeResource("sub/../.env", sandbox)).toBe(".env");
	});

	test("resolves symlinks to the canonical target path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		await writeFile(join(dir, "secret.txt"), "SECRET=1");
		await symlink(join(dir, "secret.txt"), join(dir, "link.txt"));
		const sandbox = createWorkspaceSandbox(dir);

		expect(await canonicalizeResource("link.txt", sandbox)).toBe("secret.txt");
	});

	test("normalizes missing files through sandbox new-path resolution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		const sandbox = createWorkspaceSandbox(dir);

		expect(await canonicalizeResource("missing.txt", sandbox)).toBe(
			"missing.txt"
		);
		expect(await canonicalizeResource("sub/../missing.txt", sandbox)).toBe(
			"missing.txt"
		);
	});

	test("rejects escaping inputs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		const sandbox = createWorkspaceSandbox(dir);

		await expect(
			canonicalizeResource("../outside.txt", sandbox)
		).rejects.toThrow("Path escapes workspace");
	});

	test("always returns POSIX separators", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-canonical-test-"));
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "nested", "file.txt"), "x");
		const sandbox = createWorkspaceSandbox(dir);

		expect(await canonicalizeResource("nested/file.txt", sandbox)).toBe(
			"nested/file.txt"
		);
	});
});
