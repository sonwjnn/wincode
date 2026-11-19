import { expect, test } from "bun:test";
import { RGBA } from "@wincode/tui/core";
import { testRender } from "@wincode/tui/testing";
import { act } from "react";
import {
	PROJECT_TRUST_NOTICE_MESSAGE,
	ProjectTrustNotice,
} from "@/modules/project-trust/ui/project-trust-notice";
import { ConfigProvider } from "@/shared/config/config-provider";
import {
	type ConfigRuntime,
	createConfigStore,
} from "@/shared/config/config-store";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { THEMES } from "@/shared/providers/theme/themes";
import { flushTestRenderer } from "./support/opentui";

const configRuntimeFor = (
	untrustedProjectRoots: readonly string[]
): ConfigRuntime => ({
	configStore: createConfigStore({ homeRoot: "/home/user" }),
	cwd: "/workspace/repo",
	homeRoot: "/home/user",
	trustedProjectRoots: [],
	untrustedProjectRoots,
	workspace: "/workspace/repo",
});

const renderNotice = async (untrustedProjectRoots: readonly string[]) => {
	const setup = await testRender(
		<ConfigProvider value={configRuntimeFor(untrustedProjectRoots)}>
			<ThemeProvider themeName="opencode">
				<ProjectTrustNotice />
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 20, width: 120 }
	);
	await flushTestRenderer(setup, 2);
	return setup;
};

test("untrusted project roots render the inline trust notice with the /trust hint", async () => {
	const setup = await renderNotice(["/workspace/repo"]);
	try {
		const frameText = setup.captureCharFrame().replaceAll(/\s+/gu, " ");
		expect(frameText).toContain(PROJECT_TRUST_NOTICE_MESSAGE);
		expect(PROJECT_TRUST_NOTICE_MESSAGE).toContain("restart Wincode");

		const opencodeTheme = THEMES.find(({ name }) => name === "opencode");
		if (opencodeTheme === undefined) {
			throw new Error("The opencode theme is unavailable.");
		}
		const noticeSpan = setup
			.captureSpans()
			.lines.flatMap(({ spans }) => spans)
			.find(({ text }) => text.includes("This project is not trusted."));
		expect(noticeSpan?.fg.toInts()).toEqual(
			RGBA.fromHex(opencodeTheme.colors.warning).toInts()
		);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trusted project roots render no inline trust notice", async () => {
	const setup = await renderNotice([]);
	try {
		const frameText = setup.captureCharFrame().replaceAll(/\s+/gu, " ");
		expect(frameText).not.toContain(PROJECT_TRUST_NOTICE_MESSAGE);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
