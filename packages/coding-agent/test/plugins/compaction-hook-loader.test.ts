import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginFactory } from "@wincode/coding-agent";
import { loadPlugins } from "@/modules/plugins/loader";
import { createConfigStore } from "@/shared/config/config-store";

const loadBundled = async (factory: PluginFactory, workspace: string) =>
	loadPlugins({
		bundledPlugins: [{ factory, id: "compaction_hooks" }],
		cliPaths: [],
		config: {
			configStore: createConfigStore({ homeRoot: path.dirname(workspace) }),
			cwd: workspace,
			homeRoot: path.dirname(workspace),
			workspace,
		},
	});

test("a Plugin's compaction hooks reach the runtime lifecycle", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-compaction-hooks-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const calls: string[] = [];
	const plugin: PluginFactory = (api) => {
		const definition = api.definePlugin({ id: "compaction_hooks" });
		definition.onBeforeCompaction((context) => {
			calls.push(`before:${context.trigger}`);
			return { summary: "custom handoff" };
		});
		definition.onCompactionCompleted((context) => {
			calls.push(`completed:${context.compactionId}`);
		});
		definition.onCompactionFailed((context) => {
			calls.push(`failed:${context.error}`);
		});
	};
	const runtime = await loadBundled(plugin, workspace);
	try {
		const context = {
			sessionId: "session-loaded",
			signal: new AbortController().signal,
			trigger: "threshold",
			workspace,
		} as const;
		expect(await runtime.runBeforeCompactionHooks(context)).toEqual({
			summary: "custom handoff",
		});
		await runtime.notifyCompactionCompleted({
			...context,
			compactionId: "compaction:9",
			estimatedTokensAfter: 10,
			tokensBefore: 100,
		});
		await runtime.notifyCompactionFailed({
			...context,
			error: "No summary model.",
		});
		expect(calls).toEqual([
			"before:threshold",
			"completed:compaction:9",
			"failed:No summary model.",
		]);
	} finally {
		await runtime.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("registering one compaction hook twice fails its Plugin factory", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-compaction-hook-duplicate-")
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const plugin: PluginFactory = (api) => {
		const definition = api.definePlugin({ id: "compaction_hooks" });
		definition.onCompactionCompleted(() => undefined);
		definition.onCompactionCompleted(() => undefined);
	};
	const runtime = await loadBundled(plugin, workspace);
	try {
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining(
						"'onCompactionCompleted' must be registered once"
					),
				}),
			])
		);
	} finally {
		await runtime.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});
