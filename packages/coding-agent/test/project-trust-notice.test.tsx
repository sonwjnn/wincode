import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
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
			<ThemeProvider>
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
