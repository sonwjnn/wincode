import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ConfigProvider } from "@/shared/config/config-provider";
import {
	type ConfigRuntime,
	createConfigStore,
} from "@/shared/config/config-store";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	PROJECT_TRUST_WARNING,
	ProjectTrustWarning,
} from "@/tui/project-trust-warning";
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

const renderWarning = async (untrustedProjectRoots: readonly string[]) => {
	const setup = await testRender(
		<ConfigProvider value={configRuntimeFor(untrustedProjectRoots)}>
			<ThemeProvider>
				<ProjectTrustWarning />
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 20, width: 120 }
	);
	await flushTestRenderer(setup, 2);
	return setup;
};

test("untrusted project roots render the inline trust warning with the /trust hint", async () => {
	const setup = await renderWarning(["/workspace/repo"]);
	try {
		const frameText = setup.captureCharFrame().replaceAll(/\s+/gu, " ");
		expect(frameText).toContain(PROJECT_TRUST_WARNING);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("trusted project roots render no inline trust warning", async () => {
	const setup = await renderWarning([]);
	try {
		const frameText = setup.captureCharFrame().replaceAll(/\s+/gu, " ");
		expect(frameText).not.toContain(PROJECT_TRUST_WARNING);
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
