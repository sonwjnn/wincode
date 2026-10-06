import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedTool, ToolCallOutput } from "@wincode/agent-core";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createPluginTools } from "@/modules/plugins/tools";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import { createConfigStore } from "@/shared/config/config-store";
import { toolCallId } from "../support/identifiers";

const root = await mkdtemp(path.join(os.tmpdir(), "wincode-plugin-tools-"));
const workspace = path.join(root, "workspace");
const configRoot = path.join(root, "config");
const homeRoot = path.join(root, "home");
const pluginPath = path.resolve(import.meta.dir, "../fixtures/jira-plugin.ts");
await Promise.all([
	mkdir(workspace, { recursive: true }),
	mkdir(configRoot, { recursive: true }),
]);

const config = {
	configStore: createConfigStore({ configRoot, homeRoot }),
	cwd: workspace,
	homeRoot,
	workspace,
};

const loadTool = async (
	pathToPlugin = pluginPath
): Promise<{
	gateCalls: () => number;
	pluginRuntime: PluginRuntime;
	tool: ResolvedTool;
}> => {
	const pluginRuntime = await loadPlugins({
		cliPaths: [pathToPlugin],
		config,
	});
	let gateCalls = 0;
	const gate: ToolGate = {
		gate: async () => {
			gateCalls += 1;
			return { kind: "allow" };
		},
	};
	const tool = createPluginTools({
		existingToolNames: [],
		gate,
		permissionForAction: async () => ({ decision: "allow", safety: false }),
		runtime: pluginRuntime,
		sessionId: "tool-test-session",
		workspace,
	})[0];
	if (tool === undefined) {
		throw new Error(
			`The explicitly enabled Jira Plugin Tool was not resolved: ${JSON.stringify(pluginRuntime.diagnostics)}`
		);
	}
	return {
		gateCalls: () => gateCalls,
		pluginRuntime,
		tool,
	};
};

const executeTool = (
	tool: ResolvedTool,
	input: unknown
): Promise<ToolCallOutput> =>
	tool.execute({ input, toolCallId: toolCallId("plugin-tools-test-call") });

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

test("invalid Plugin Tool input fails before approval or handler execution", async () => {
	const { gateCalls, pluginRuntime, tool } = await loadTool();
	try {
		const result = await executeTool(tool, { query: 12 });

		expect(result).toMatchObject({
			errorText: "Plugin Tool input did not match its declared schema.",
			type: "failure",
		});
		expect(gateCalls()).toBe(0);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("oversized Plugin Tool JSON is replaced with a bounded failure", async () => {
	const { gateCalls, pluginRuntime, tool } = await loadTool();
	try {
		const result = await executeTool(tool, { query: "x".repeat(64 * 1024) });

		expect(result).toMatchObject({
			errorText: "Plugin Tool output exceeded the 64 KiB limit.",
			type: "failure",
		});
		expect(gateCalls()).toBe(1);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("a stateful array toJSON hook cannot grow output after the host bounds it", async () => {
	const pluginPathWithArrayHook = path.resolve(
		import.meta.dir,
		"../fixtures/stateful-array-plugin.ts"
	);
	const { pluginRuntime, tool } = await loadTool(pluginPathWithArrayHook);
	try {
		const result = await executeTool(tool, { query: "WCO-12" });

		expect(result).toMatchObject({
			errorText: "Plugin Tool returned a non-JSON result.",
			type: "failure",
		});
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("mutable Plugin Tool JSON is delivered as the bounded snapshot", async () => {
	const pluginPathWithGetter = path.resolve(
		import.meta.dir,
		"../fixtures/mutable-output-plugin.ts"
	);
	const { pluginRuntime, tool } = await loadTool(pluginPathWithGetter);
	try {
		const result = await executeTool(tool, { query: "WCO-12" });
		if (result.type !== "success") {
			throw new Error(
				`Expected a bounded JSON result, received ${result.errorText}`
			);
		}

		expect(JSON.stringify(result.output)).toBe('{"query":"small"}');
	} finally {
		await pluginRuntime.shutdown();
	}
});
