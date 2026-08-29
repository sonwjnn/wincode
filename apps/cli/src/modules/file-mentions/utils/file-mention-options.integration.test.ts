import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFileMentionOptions } from "./file-mention-options";

const workspaces: string[] = [];

const createWorkspace = async () => {
	const workspace = await mkdtemp(
		path.join(tmpdir(), "wincode-mention-options-")
	);
	workspaces.push(workspace);
	return workspace;
};

afterEach(async () => {
	while (workspaces.length > 0) {
		const workspace = workspaces.pop();
		if (workspace) {
			await rm(workspace, { force: true, recursive: true });
		}
	}
});

describe("file mention option discovery", () => {
	test("discovers deeply nested entries and skips ignored directories", async () => {
		const workspace = await createWorkspace();
		const deepDirectory = "apps/cli/src/modules/conversations/ui/messages";
		await mkdir(path.join(workspace, deepDirectory), { recursive: true });
		await mkdir(path.join(workspace, "node_modules/deep"), { recursive: true });
		await mkdir(path.join(workspace, "dist"), { recursive: true });
		await writeFile(
			path.join(workspace, `${deepDirectory}/bot-message.tsx`),
			"content"
		);
		await writeFile(
			path.join(workspace, "node_modules/deep/bot-message.tsx"),
			"ignored"
		);
		await writeFile(path.join(workspace, "dist/generated.ts"), "ignored");

		const options = await getFileMentionOptions({ root: workspace });
		const paths = options.map((option) => option.path);

		expect(paths).toContain(`${deepDirectory}/bot-message.tsx`);
		expect(paths).not.toContain("node_modules/deep/bot-message.tsx");
		expect(paths).not.toContain("dist/generated.ts");
		expect(options).toContainEqual({
			label: "apps/cli/src/modules/conversations/ui/messages/",
			path: "apps/cli/src/modules/conversations/ui/messages",
			type: "directory",
		});
	});
	test("omits gitignored entries from autocomplete discovery", async () => {
		const workspace = await createWorkspace();
		await writeFile(
			path.join(workspace, ".gitignore"),
			"ignored.ts\nignored-dir/\n*.secret\n"
		);
		await mkdir(path.join(workspace, "ignored-dir"));
		await writeFile(path.join(workspace, "ignored.ts"), "ignored");
		await writeFile(path.join(workspace, "ignored-dir/nested.ts"), "ignored");
		await mkdir(path.join(workspace, "nested"));
		await writeFile(
			path.join(workspace, "nested/.gitignore"),
			"secret.ts\n!keep.secret\n"
		);
		await writeFile(path.join(workspace, "nested/secret.ts"), "ignored");
		await writeFile(path.join(workspace, "nested/keep.secret"), "visible");
		await writeFile(path.join(workspace, "visible.ts"), "visible");

		const options = await getFileMentionOptions({ root: workspace });
		const paths = options.map((option) => option.path);

		expect(paths).toContain("visible.ts");
		expect(paths).not.toContain("ignored.ts");
		expect(paths).not.toContain("ignored-dir");
		expect(paths).not.toContain("ignored-dir/nested.ts");
		expect(paths).not.toContain("nested/secret.ts");
		expect(paths).toContain("nested/keep.secret");
	});
});
