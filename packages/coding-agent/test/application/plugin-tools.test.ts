import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	agentIdSchema,
	type ResolvedTool,
	type ToolCallOutput,
} from "@wincode/agent-core";
import { createPermissionService } from "@/modules/permissions/permission-service";
import { resolvePluginToolPermission } from "@/modules/permissions/resolve";
import { loadPlugins } from "@/modules/plugins/loader";
import { permissionActionForPluginTool } from "@/modules/plugins/permission-action";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { createPluginTools } from "@/modules/plugins/tools";
import type { GateCall, ToolGate } from "@/modules/tool-gate/tool-gate";
import type {
	ConfigDocument,
	ConfigSnapshot,
} from "@/shared/config/config-store";
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

const permissionSnapshot = (
	document: Record<string, unknown>
): ConfigSnapshot => ({
	diagnostics: [],
	document: fromPartial<ConfigDocument>({}),
	sourceFor: () => undefined,
	sources: [
		{
			document: fromPartial<ConfigDocument>(document),
			path: "/home/user/.config/wincode/wincode.json",
			scope: "global",
		},
	],
});

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
		resolvePermissionForAction: async () => ({
			decision: "allow",
			safety: false,
		}),
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
			resolvePermissionForAction: async () => ({
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

test("Plugin metadata and direct names cannot bypass the default Tool Permission ask", async () => {
	const directNamePluginPath = path.resolve(
		import.meta.dir,
		"../fixtures/direct-name-permission-plugin.ts"
	);
	const pluginRuntime = await loadPlugins({
		cliPaths: [directNamePluginPath],
		config,
	});
	const agentId = agentIdSchema.parse("build");
	const pluginTools = await pluginRuntime.resolveToolsForTurn({
		agentId,
		sessionId: "direct-name-permission-session",
		signal: new AbortController().signal,
		workspace,
	});
	const gateCalls: GateCall[] = [];
	let handlerCalls = 0;
	const tools = createPluginTools({
		agentId,
		existingToolNames: [],
		gate: {
			gate: async (call) => {
				gateCalls.push(call);
				return { errorText: "Approval required.", kind: "deny" };
			},
		},
		pluginTools: pluginTools.map((tool) => ({
			...tool,
			handler: async (input, context) => {
				handlerCalls += 1;
				return tool.handler(input, context);
			},
		})),
		resolvePermissionForAction: async (action, resource) => {
			expect({ action, resource }).toEqual({
				action: "plugin:direct_permission:read",
				resource: "*",
			});
			return { decision: "ask", safety: false };
		},
		sessionId: "direct-name-permission-session",
		workspace,
	});
	try {
		expect(pluginTools.map(({ name }) => name)).toEqual(["external_search"]);
		expect(tools).toHaveLength(1);
		const tool = tools[0];
		if (tool === undefined) {
			throw new Error("Expected the direct-name Plugin Tool.");
		}
		const result = await executeTool(tool, {});

		expect(result).toMatchObject({
			errorText: "Approval required.",
			type: "failure",
		});
		expect(gateCalls).toMatchObject([
			{
				action: "plugin:direct_permission:read",
				decision: "ask",
				family: "plugin",
				toolName: "external_search",
			},
		]);
		expect(handlerCalls).toBe(0);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("a native edit grant cannot authorize a Plugin-chosen edit action", async () => {
	const pluginPermissionAction = "plugin:permission_override:edit";
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({ permission: { edit: "allow" } }),
			"build",
			pluginPermissionAction,
			"*"
		).decision
	).toBe("ask");
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({
				permission: { [pluginPermissionAction]: "allow" },
			}),
			"build",
			pluginPermissionAction,
			"*"
		).decision
	).toBe("allow");

	const permissionOverridePluginPath = path.resolve(
		import.meta.dir,
		"../fixtures/permission-override-plugin.ts"
	);
	const pluginRuntime = await loadPlugins({
		cliPaths: [permissionOverridePluginPath],
		config,
	});
	const agentId = agentIdSchema.parse("build");
	const sessionId = "native-permission-alias-session";
	const pluginTools = await pluginRuntime.resolveToolsForTurn({
		agentId,
		sessionId,
		signal: new AbortController().signal,
		workspace,
	});
	const gateCalls: GateCall[] = [];
	const tools = createPluginTools({
		agentId,
		existingToolNames: [],
		gate: {
			gate: async (call) => {
				gateCalls.push(call);
				return { errorText: "Approval required.", kind: "deny" };
			},
		},
		pluginTools,
		resolvePermissionForAction: async (action, resource) =>
			resolvePluginToolPermission(
				permissionSnapshot({ permission: { edit: "allow" } }),
				"build",
				action,
				resource
			),
		sessionId,
		workspace,
	});
	try {
		const tool = tools[0];
		if (tool === undefined) {
			throw new Error("Expected the permission-override Plugin Tool.");
		}
		const result = await executeTool(tool, {});

		expect(result).toMatchObject({
			errorText: "Approval required.",
			type: "failure",
		});
		expect(gateCalls).toMatchObject([
			{
				action: "plugin:permission_override:edit",
				decision: "ask",
				family: "plugin",
				toolName: "external_edit",
			},
		]);
	} finally {
		await pluginRuntime.shutdown();
	}
});

test("a Plugin external-directory approval cannot grant the host path boundary", () => {
	const action = permissionActionForPluginTool({
		action: "plugin:mcp:directory",
		permissionAction: "external_directory",
		pluginId: "mcp",
	});
	const permissionService = createPermissionService();

	expect(action).toBe("plugin:mcp:external_directory");
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({ permission: { external_directory: "allow" } }),
			"build",
			action
		).decision
	).toBe("ask");
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({ permission: { [action]: "allow" } }),
			"build",
			action
		).decision
	).toBe("allow");

	permissionService.grant(action, "*");
	expect(permissionService.isGranted(action, "*")).toBe(true);
	expect(
		permissionService.isGranted("external_directory", "/outside/secrets.txt")
	).toBe(false);
});

test("a native delegate grant cannot authorize a Plugin-chosen delegate action", () => {
	const action = permissionActionForPluginTool({
		action: "plugin:permission_override:delegate_tool",
		permissionAction: "delegate",
		pluginId: "permission_override",
	});

	expect(action).toBe("plugin:permission_override:delegate");
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({ permission: { delegate: "allow" } }),
			"build",
			action
		).decision
	).toBe("ask");
	expect(
		resolvePluginToolPermission(
			permissionSnapshot({ permission: { [action]: "allow" } }),
			"build",
			action
		).decision
	).toBe("allow");
});
