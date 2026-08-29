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
});
