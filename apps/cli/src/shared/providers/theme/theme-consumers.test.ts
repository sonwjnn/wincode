import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("theme consumers", () => {
	test("floating overlays use menu background", async () => {
		const [dialogSource, toastSource] = await Promise.all([
			readFile(
				new URL("../dialog/dialog-provider.tsx", import.meta.url),
				"utf8"
			),
			readFile(new URL("../toast/toast-provider.tsx", import.meta.url), "utf8"),
		]);

		expect(dialogSource).toContain("backgroundColor={colors.backgroundMenu}");
		expect(toastSource).toContain("backgroundColor={colors.backgroundMenu}");
	});

	test("conversation shell uses semantic theme roles", async () => {
		const [chatInputSource, sidebarSource, shellSource, workspaceSource] =
			await Promise.all([
				readFile(
					new URL(
						"../../../modules/conversations/ui/components/chat-text-area.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/conversations/ui/components/session-sidebar.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/conversations/ui/components/chat-shell.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/conversations/ui/components/workspace-path.tsx",
						import.meta.url
					),
					"utf8"
				),
			]);

		expect(chatInputSource).toContain("colors.borderActive");
		expect(chatInputSource).toContain("colors.backgroundElement");
		expect(sidebarSource).toContain("colors.backgroundPanel");
		expect(sidebarSource).toContain("colors.textMuted");
		expect(shellSource).toContain("colors.textMuted");
		expect(workspaceSource).toContain("colors.textMuted");
	});
});
