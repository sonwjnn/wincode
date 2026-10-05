import { expect, test } from "bun:test";
import {
	MockTreeSitterClient,
	type TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { BotMessageContent } from "@/modules/sessions/ui/messages/bot-message";
import { setMarkdownTreeSitterClientForTests } from "@/modules/sessions/ui/messages/markdown-message-part";
import {
	type SettingsOperations,
	SettingsRegistryProvider,
	useSettingsOperations,
} from "@/modules/settings";
import { ConfigProvider } from "@/shared/config/config-provider";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	createInMemoryConfigStore,
	TEST_CONFIG_ROOT,
	TEST_HOME_ROOT,
} from "../support/config-store";
import { flushTestRenderer } from "../support/opentui";

const WORKSPACE = "/workspace";

const flushRenders = async (setup: TestRendererSetup): Promise<void> => {
	await flushTestRenderer(setup, 3);
	await setup.flush({ maxPasses: 20 });
};

test("global Hide thinking replaces live and historical reasoning and reset restores it", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const files: Record<string, string> = {};
	const configStore = createInMemoryConfigStore(files);
	const configValue = {
		configStore,
		homeRoot: TEST_HOME_ROOT,
		workspace: WORKSPACE,
	};
	let settingsOperations: SettingsOperations | undefined;

	function Harness() {
		settingsOperations = useSettingsOperations();
		return (
			<box flexDirection="column">
				<BotMessageContent
					parts={[{ text: "previous thought", type: "reasoning" }]}
				/>
				<BotMessageContent
					parts={[{ text: "current thought", type: "reasoning" }]}
				/>
			</box>
		);
	}

	const previousTreeSitterClient = setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);

	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<SettingsRegistryProvider>
							<Harness />
						</SettingsRegistryProvider>
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 12, width: 100 }
	);

	try {
		await act(async () => {
			for (let pass = 0; pass < 20; pass += 1) {
				await Bun.sleep(20);
				await setup.renderOnce();
				if (setup.captureCharFrame().includes("previous thought")) {
					break;
				}
			}
		});
		await flushRenders(setup);
		const operations = settingsOperations;
		if (operations === undefined) {
			throw new Error("Settings operations did not initialize.");
		}
		const visibleFrame = setup.captureCharFrame();
		expect(visibleFrame).toContain("previous thought");
		expect(visibleFrame).toContain("current thought");

		await act(async () => {
			await operations.setValue("display.hideThinking", true);
		});
		await flushRenders(setup);
		const hiddenFrame = setup.captureCharFrame();
		expect(hiddenFrame.match(/Thinking\.\.\./gu)).toHaveLength(2);
		expect(hiddenFrame).not.toContain("previous thought");
		expect(hiddenFrame).not.toContain("current thought");
		expect(JSON.parse(files[configFile] ?? "{}")).toEqual({
			display: { hideThinking: true },
		});

		await act(async () => {
			await operations.resetValue("display.hideThinking");
		});
		await flushRenders(setup);
		const resetFrame = setup.captureCharFrame();
		expect(resetFrame).toContain("previous thought");
		expect(resetFrame).toContain("current thought");
	} finally {
		act(() => setup.renderer.destroy());
		setMarkdownTreeSitterClientForTests(previousTreeSitterClient);
	}
});

test("keeps reasoning visible until a saved Hide thinking preference loads", async () => {
	const configFile = `${TEST_CONFIG_ROOT}/wincode.json`;
	const files: Record<string, string> = {
		[configFile]: '{"display":{"hideThinking":true}}',
	};
	const baseConfigStore = createInMemoryConfigStore(files);
	const initialReadStarted = Promise.withResolvers<void>();
	const releaseInitialRead = Promise.withResolvers<void>();
	const configStore = {
		...baseConfigStore,
		getSnapshot: async (workspace: string) => {
			initialReadStarted.resolve();
			await releaseInitialRead.promise;
			return baseConfigStore.getSnapshot(workspace);
		},
	};
	const configValue = {
		configStore,
		homeRoot: TEST_HOME_ROOT,
		workspace: WORKSPACE,
	};
	const previousTreeSitterClient = setMarkdownTreeSitterClientForTests(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
	const setup = await testRender(
		<ConfigProvider value={configValue}>
			<ThemeProvider>
				<KeyboardLayerProvider>
					<ApprovalPanelsProvider>
						<SettingsRegistryProvider>
							<BotMessageContent
								parts={[{ text: "stored thought", type: "reasoning" }]}
							/>
						</SettingsRegistryProvider>
					</ApprovalPanelsProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>
		</ConfigProvider>,
		{ height: 8, width: 100 }
	);

	try {
		await initialReadStarted.promise;
		await flushRenders(setup);
		const pendingFrame = setup.captureCharFrame();
		expect(pendingFrame).toContain("stored thought");
		expect(pendingFrame).not.toContain("Thinking...");

		releaseInitialRead.resolve();
		await flushRenders(setup);
		const loadedFrame = setup.captureCharFrame();
		expect(loadedFrame).toContain("Thinking...");
		expect(loadedFrame).not.toContain("stored thought");
	} finally {
		act(() => setup.renderer.destroy());
		setMarkdownTreeSitterClientForTests(previousTreeSitterClient);
	}
});
