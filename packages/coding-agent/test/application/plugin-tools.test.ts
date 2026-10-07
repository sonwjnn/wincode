import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentIdSchema,
	type ResolvedTool,
	type ToolCallOutput,
} from "@wincode/agent-core";
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
	const sessionId = "tool-test-session";
	const agentId = agentIdSchema.parse("build");
	const pluginTools = await pluginRuntime.resolveToolsForTurn({
		agentId,
		sessionId,
		signal: new AbortController().signal,
		workspace,
	});
	const tool = createPluginTools({
		agentId,
		existingToolNames: [],
		gate,
		permissionForAction: async () => ({ decision: "allow", safety: false }),
		pluginTools,
		registerBackgroundWork: (activeSessionId, work) =>
			pluginRuntime.registerBackgroundWork(activeSessionId, work),
		sessionId,
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

test("a file Plugin can register work that One-Shot waits for generically", async () => {
	const backgroundPluginPath = path.resolve(
		import.meta.dir,
		"../fixtures/background-work-plugin.ts"
	);
	const { pluginRuntime, tool } = await loadTool(backgroundPluginPath);
	try {
		await expect(executeTool(tool, { inspect: false })).resolves.toMatchObject({
			output: "started",
			type: "success",
		});
		await pluginRuntime.waitForBackgroundWork("tool-test-session");
		await expect(executeTool(tool, { inspect: true })).resolves.toMatchObject({
			output: true,
			type: "success",
		});
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("a colliding final Plugin tool name does not discard unrelated tools", async () => {
	const { pluginRuntime } = await loadTool();
	try {
		const [collidingTool] =
			pluginRuntime.getToolDescriptors("tool-test-session");
		if (collidingTool === undefined) {
			throw new Error("Expected the Jira Plugin Tool descriptor.");
		}
		const unrelatedTool = {
			...collidingTool,
			localName: "unrelated",
			name: "plugin_jira_unrelated",
		};
		const result = createPluginTools({
			agentId: agentIdSchema.parse("build"),
			existingToolNames: [collidingTool.name],
			gate: { gate: async () => ({ kind: "allow" }) },
			permissionForAction: async () => ({
				decision: "allow",
				safety: false,
			}),
			pluginTools: [collidingTool, unrelatedTool],
			sessionId: "tool-test-session",
			workspace,
		});

		expect(result.map(({ definition }) => definition.name)).toEqual([
			"plugin_jira_unrelated",
		]);
	} finally {
		await pluginRuntime.shutdown();
	}
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

test("JSON Schema Plugin inputs validate before the Tool Gate", async () => {
	const jsonSchemaPluginPath = path.resolve(
		import.meta.dir,
		"../fixtures/json-schema-plugin.ts"
	);
	const { gateCalls, pluginRuntime, tool } =
		await loadTool(jsonSchemaPluginPath);
	try {
		const invalid = await executeTool(tool, { query: 12 });
		const valid = await executeTool(tool, { query: "WCO-12" });

		expect(invalid).toMatchObject({
			errorText: "Plugin Tool input did not match its declared schema.",
			type: "failure",
		});
		expect(valid).toMatchObject({
			output: { query: "WCO-12" },
			type: "success",
		});
		expect(gateCalls()).toBe(1);
	} finally {
		await pluginRuntime.shutdown();
	}
});
