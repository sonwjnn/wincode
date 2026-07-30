import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const readSource = (path: string) =>
	readFile(new URL(path, import.meta.url), "utf8");
const FIXED_TERMINAL_COLOR_RE = /(?:fg|color)="(?:white|gray|#E1E1E1)"/;

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

	test("conversation messages use semantic theme roles", async () => {
		const [userSource, errorSource, botSource, statusSource] =
			await Promise.all([
				readFile(
					new URL(
						"../../../modules/conversations/ui/messages/user-message.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/conversations/ui/messages/error-message.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/conversations/ui/messages/bot-message.tsx",
						import.meta.url
					),
					"utf8"
				),
				readFile(
					new URL(
						"../../../modules/prompt-settings/ui/prompt-status-bar.tsx",
						import.meta.url
					),
					"utf8"
				),
			]);

		expect(userSource).toContain("backgroundColor={colors.backgroundPanel}");
		expect(errorSource).toContain("backgroundColor={colors.backgroundPanel}");
		expect(botSource).toContain("colors.textMuted");
		expect(statusSource).toContain("fg={colors.textMuted}");
	});

	test("uses semantic foregrounds instead of fixed terminal colors", async () => {
		const paths = [
			"../dialog/dialog-provider.tsx",
			"../toast/toast-provider.tsx",
			"../../../modules/commands/ui/command-menu.tsx",
			"../../../modules/connections/ui/connection-method-picker-dialog.tsx",
			"../../../modules/prompt-settings/ui/models-dialog.tsx",
			"../../../modules/prompt-settings/ui/agents-dialog.tsx",
			"../../../modules/prompt-settings/ui/variants-dialog.tsx",
			"../../../modules/prompt-settings/ui/theme-dialog.tsx",
			"../../../modules/connections/ui/connection-provider-picker-dialog.tsx",
			"../../../modules/file-mentions/ui/file-mention-menu.tsx",
			"../../../modules/conversations/ui/dialogs/sessions-dialog.tsx",
		];
		const combined = (await Promise.all(paths.map(readSource))).join("\n");

		expect(combined).toContain("colors.text");
		expect(combined).toContain("colors.textMuted");
		expect(combined).not.toMatch(FIXED_TERMINAL_COLOR_RE);
	});
});
