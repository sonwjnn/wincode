import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const readSource = (path: string) =>
	readFile(new URL(path, import.meta.url), "utf8");
const FIXED_TERMINAL_COLOR_RE = /(?:fg|color)="(?:white|gray|#E1E1E1)"/;
const LEGACY_THEME_TOKEN_RE =
	/\b(?:dialogSurface|dimSeparator|sidebarBackground|suggestionBorder|thinkingBorder)\b|colors\.surface/;
const LITERAL_FOREGROUND_RE =
	/(?:fg|textColor|focusedTextColor|placeholderColor)="(?:[A-Za-z]+|#[0-9A-Fa-f]{3,8})"/;

const readProductionSources = async () => {
	const srcRoot = new URL("../../../", import.meta.url);
	const entries = await readdir(srcRoot, {
		recursive: true,
		withFileTypes: true,
	});
	const files = entries
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".tsx") &&
				!entry.name.endsWith(".test.tsx") &&
				entry.name !== "routeTree.gen.ts"
		)
		.map(async (entry) => {
			const path = join(entry.parentPath, entry.name);
			return {
				path: relative(srcRoot.pathname, path),
				source: await readFile(path, "utf8"),
			};
		});
	return Promise.all(files);
};

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

	test("does not use legacy theme tokens", async () => {
		const paths = [
			"./themes.ts",
			"./theme-provider.tsx",
			"../dialog/dialog-provider.tsx",
			"../toast/toast-provider.tsx",
			"../../../modules/conversations/ui/components/chat-text-area.tsx",
			"../../../modules/conversations/ui/components/chat-shell.tsx",
			"../../../modules/conversations/ui/components/session-sidebar.tsx",
			"../../../modules/conversations/ui/components/workspace-path.tsx",
			"../../../modules/conversations/ui/components/session-usage-bar.tsx",
			"../../../modules/conversations/ui/dialogs/rename-session-dialog.tsx",
			"../../../modules/conversations/ui/dialogs/sessions-dialog.tsx",
			"../../../modules/conversations/ui/messages/bot-message.tsx",
			"../../../modules/conversations/ui/messages/error-message.tsx",
			"../../../modules/conversations/ui/messages/user-message.tsx",
		];
		const sources = await Promise.all(paths.map(readSource));

		for (const [index, source] of sources.entries()) {
			expect(source, paths[index]).not.toMatch(LEGACY_THEME_TOKEN_RE);
		}
	});

	test("all production TSX consumers use semantic foregrounds", async () => {
		const sources = await readProductionSources();
		for (const { path, source } of sources) {
			expect(source, path).not.toMatch(LEGACY_THEME_TOKEN_RE);
			expect(source, path).not.toMatch(LITERAL_FOREGROUND_RE);
		}
	});

	test("representative consumers expose semantic text roles", async () => {
		const checks = new Map([
			[
				"../../../modules/conversations/ui/components/chat-text-area.tsx",
				[
					"disabled ? colors.textDisabled : colors.text",
					"placeholderColor={colors.textMuted}",
				],
			],
			[
				"../../../modules/conversations/ui/components/session-sidebar.tsx",
				["color={colors.text}", "colors.textMuted"],
			],
			[
				"../../../modules/conversations/ui/messages/bot-message.tsx",
				["colors.text"],
			],
			[
				"../../ui/search-list-dialog-wrapper.tsx",
				[
					"focusedTextColor={colors.text}",
					"placeholderColor={colors.textMuted}",
					"emptyText",
				],
			],
			["../../../index.tsx", ["colors.text"]],
			["../../../app/routes/__root.tsx", ["colors.error"]],
			[
				"../../../modules/connections/ui/connection-api-key-dialog.tsx",
				[
					"focusedTextColor={colors.text}",
					"placeholderColor={colors.textMuted}",
				],
			],
			[
				"../../../modules/conversations/ui/dialogs/rename-session-dialog.tsx",
				["focusedTextColor={colors.text}"],
			],
		]);
		for (const [path, expected] of checks) {
			const source = await readSource(path);
			for (const text of expected) {
				expect(source, path).toContain(text);
			}
		}
	});
});
