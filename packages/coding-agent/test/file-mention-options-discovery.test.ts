import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getFileMentionOptions } from "@/modules/file-mentions/utils/file-mention-options";

const workspaces: string[] = [];

const createWorkspace = async () => {
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-mention-options-")
	);
	workspaces.push(workspace);
	return workspace;
};

afterEach(async () => {
	while (workspaces.length > 0) {
		const workspace = workspaces.pop();
		if (workspace) {
			await fs.rm(workspace, { force: true, recursive: true });
		}
	}
});

describe("file mention option discovery", () => {
	test("discovers deeply nested entries and skips ignored directories", async () => {
		const workspace = await createWorkspace();
		const deepDirectory = "packages/coding-agent/modules/sessions/ui/messages";
		await fs.mkdir(path.join(workspace, deepDirectory), { recursive: true });
		await fs.mkdir(path.join(workspace, "node_modules/deep"), {
			recursive: true,
		});
		await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
		await Bun.write(
			path.join(workspace, `${deepDirectory}/bot-message.tsx`),
			"content"
		);
		await Bun.write(
			path.join(workspace, "node_modules/deep/bot-message.tsx"),
			"ignored"
		);
		await Bun.write(path.join(workspace, "dist/generated.ts"), "ignored");

		const options = await getFileMentionOptions({ root: workspace });
		const paths = options.map((option) => option.path);

		expect(paths).toContain(`${deepDirectory}/bot-message.tsx`);
		expect(paths).not.toContain("node_modules/deep/bot-message.tsx");
		expect(paths).not.toContain("dist/generated.ts");
		expect(options).toContainEqual({
			label: "packages/coding-agent/modules/sessions/ui/messages/",
			path: "packages/coding-agent/modules/sessions/ui/messages",
			type: "directory",
		});
	});
	test("omits gitignored entries from autocomplete discovery", async () => {
		const workspace = await createWorkspace();
		await Bun.write(
			path.join(workspace, ".gitignore"),
			"ignored.ts\nignored-dir/\n*.secret\n"
		);
		await fs.mkdir(path.join(workspace, "ignored-dir"));
		await Bun.write(path.join(workspace, "ignored.ts"), "ignored");
		await Bun.write(path.join(workspace, "ignored-dir/nested.ts"), "ignored");
		await fs.mkdir(path.join(workspace, "nested"));
		await Bun.write(
			path.join(workspace, "nested/.gitignore"),
			"secret.ts\n!keep.secret\n"
		);
		await Bun.write(path.join(workspace, "nested/secret.ts"), "ignored");
		await Bun.write(path.join(workspace, "nested/keep.secret"), "visible");
		await Bun.write(path.join(workspace, "visible.ts"), "visible");

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
