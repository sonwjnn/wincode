import { expect, test } from "bun:test";
import {
	AgentInvariantError,
	type ResolvedTool,
	type ToolDefinition,
} from "@wincode/agent-core";
import { isObjectLike } from "@wincode/utils";
import { z } from "zod";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import {
	type ApplicationToolProviderFactory,
	createApplicationToolRegistry,
	type ToolProviderRegistration,
} from "@/modules/application/plugins/registry";

const definition = (name: string): ToolDefinition => ({
	description: `${name} tool`,
	inputSchema: z.object({}),
	name,
});
const resolvedTool = (name: string): ResolvedTool => ({
	definition: definition(name),
	execute: async () => ({ output: null, type: "success" }),
});

test("Native Tool Registry projects only provider capabilities for each per-turn resolution", async () => {
	let pluginInitializations = 0;
	const projectedContexts: { toolName: string }[] = [];
	const plugin: ApplicationToolProviderFactory<{
		toolName: string;
		secret: string;
	}> = (api) => {
		pluginInitializations += 1;
		api.registerToolProvider({
			id: "coding",
			policyCategory: "coding",
			selectContext: ({ toolName }) => ({ toolName }),
			adapter: {
				policyCategory: "coding",
				resolve: (context) => {
					projectedContexts.push(context);
					return [resolvedTool(context.toolName)];
				},
			},
		});
	};
	const registry = createApplicationToolRegistry({ providers: [plugin] });

	const firstTurn = await registry.resolve({
		toolName: "read",
		secret: "token",
	});
	const secondTurn = await registry.resolve({
		toolName: "write",
		secret: "token",
	});

	expect(pluginInitializations).toBe(1);
	expect(projectedContexts).toEqual([
		{ toolName: "read" },
		{ toolName: "write" },
	]);
	expect(firstTurn.map(({ definition: tool }) => tool.name)).toEqual(["read"]);
	expect(secondTurn.map(({ definition: tool }) => tool.name)).toEqual([
		"write",
	]);
});

test("provider registration snapshots resolver functions before the Plugin returns", async () => {
	const provider = {
		id: "coding",
		policyCategory: "coding" as const,
		selectContext: (context: undefined) => context,
		adapter: {
			policyCategory: "coding" as const,
			resolve: () => [resolvedTool("read")],
		},
	};
	const plugin: ApplicationToolProviderFactory<undefined> = (api) => {
		api.registerToolProvider(provider);
		provider.adapter.resolve = () => [resolvedTool("write")];
	};
	const registry = createApplicationToolRegistry({ providers: [plugin] });

	const tools = await registry.resolve(undefined);

	expect(tools.map(({ definition: tool }) => tool.name)).toEqual(["read"]);
});

test("the composition root selects the Subagents Plugin without Session adapters", () => {
	const base = createApplicationPluginComposition({
		createMcpResource: false,
		enabledPlugins: [],
		workspace: "/workspace",
	});
	const selected = createApplicationPluginComposition({
		createMcpResource: false,
		enabledPlugins: ["subagents"],
		workspace: "/workspace",
	});
	expect(base.bundledPlugins).toEqual([]);
	expect(selected.bundledPlugins.map(({ id }) => id)).toEqual(["subagents"]);
	expect(selected.enabledPlugins).toEqual(["subagents"]);
});

test("native Skill tools join the same registry without being a Plugin", async () => {
	const skillProvider: ToolProviderRegistration<undefined> = {
		id: "native-skill",
		policyCategory: "skill",
		selectContext: (context) => context,
		adapter: {
			policyCategory: "skill",
			resolve: () => [resolvedTool("skill")],
		},
	};
	const registry = createApplicationToolRegistry({
		nativeToolProviders: [skillProvider],
		providers: [],
	});

	const tools = await registry.resolve(undefined);

	expect(tools.map(({ definition: tool }) => tool.name)).toEqual(["skill"]);
});

test("duplicate model-visible names fail before an Agent Turn receives tools", async () => {
	const registry = createApplicationToolRegistry<{ collision: boolean }>({
		providers: [
			(api) =>
				api.registerToolProvider({
					id: "coding",
					policyCategory: "coding",
					selectContext: () => undefined,
					adapter: {
						policyCategory: "coding",
						resolve: () => [resolvedTool("read")],
					},
				}),
			(api) =>
				api.registerToolProvider({
					id: "mcp",
					policyCategory: "mcp",
					selectContext: (context) => context,
					adapter: {
						policyCategory: "mcp",
						resolve: ({ collision }) =>
							collision ? [resolvedTool("read")] : [resolvedTool("mcp_search")],
					},
				}),
		],
	});

	await expect(registry.resolve({ collision: true })).rejects.toMatchObject({
		code: "invalid-registry",
		message: expect.stringContaining("read"),
	});
});

test("an undeclared policy category is rejected during plugin registration", () => {
	const invalidProvider = {
		id: "unsafe",
		policyCategory: "unreviewed",
		selectContext: (context: undefined) => context,
		adapter: {
			policyCategory: "unreviewed",
			resolve: () => [],
		},
	} as unknown as ToolProviderRegistration<undefined>;
	const plugin: ApplicationToolProviderFactory<undefined> = (api) =>
		api.registerToolProvider(invalidProvider);

	expect(() => createApplicationToolRegistry({ providers: [plugin] })).toThrow(
		AgentInvariantError
	);
});

test("a declared policy category without its family adapter is rejected", () => {
	const invalidProvider = {
		id: "unadapted",
		policyCategory: "coding",
		selectContext: (context: undefined) => context,
	} as unknown as ToolProviderRegistration<undefined>;
	const plugin: ApplicationToolProviderFactory<undefined> = (api) =>
		api.registerToolProvider(invalidProvider);

	expect(() => createApplicationToolRegistry({ providers: [plugin] })).toThrow(
		AgentInvariantError
	);
});

test("a family adapter must match its declared policy category", () => {
	const invalidProvider = {
		id: "mismatched",
		policyCategory: "coding",
		selectContext: (context: undefined) => context,
		adapter: {
			policyCategory: "shell",
			resolve: () => [],
		},
	} as unknown as ToolProviderRegistration<undefined>;
	const plugin: ApplicationToolProviderFactory<undefined> = (api) =>
		api.registerToolProvider(invalidProvider);

	expect(() => createApplicationToolRegistry({ providers: [plugin] })).toThrow(
		AgentInvariantError
	);
});

test("providers without a context projection are rejected before resolution", () => {
	const invalidProvider = {
		id: "unprojected",
		policyCategory: "coding",
		adapter: {
			policyCategory: "coding",
			resolve: () => [],
		},
	} as unknown as ToolProviderRegistration<undefined>;
	const plugin: ApplicationToolProviderFactory<undefined> = (api) =>
		api.registerToolProvider(invalidProvider);

	expect(() => createApplicationToolRegistry({ providers: [plugin] })).toThrow(
		AgentInvariantError
	);
});

test("duplicate provider identities are rejected during registration", () => {
	const duplicateProvider: ToolProviderRegistration<undefined> = {
		id: "coding",
		policyCategory: "coding",
		selectContext: (context) => context,
		adapter: {
			policyCategory: "coding",
			resolve: () => [],
		},
	};
	const plugin: ApplicationToolProviderFactory<undefined> = (api) =>
		api.registerToolProvider(duplicateProvider);

	expect(() =>
		createApplicationToolRegistry({
			nativeToolProviders: [duplicateProvider],
			providers: [plugin],
		})
	).toThrow(AgentInvariantError);
});

test("plugins cannot change tool registration after host initialization", () => {
	let registerAgain: (() => void) | undefined;
	const registry = createApplicationToolRegistry({
		providers: [
			(api) => {
				registerAgain = () =>
					api.registerToolProvider({
						id: "late",
						policyCategory: "coding",
						selectContext: (context) => context,
						adapter: {
							policyCategory: "coding",
							resolve: () => [],
						},
					});
			},
		],
	});
	expect(registry).toBeDefined();
	expect(() => registerAgain?.()).toThrow(AgentInvariantError);
});

test("JSON Schema snapshots detach and freeze their nested per-turn shape", async () => {
	const sourceSchema = {
		jsonSchema: {
			properties: { path: { type: "string" } },
			type: "object",
		},
	};
	const tool: ResolvedTool = {
		definition: {
			description: "Read a file.",
			inputSchema: sourceSchema,
			name: "read",
		},
		execute: async () => ({ output: null, type: "success" }),
	};
	const registry = createApplicationToolRegistry<undefined>({
		providers: [
			(api) =>
				api.registerToolProvider({
					id: "coding",
					policyCategory: "coding",
					selectContext: (context) => context,
					adapter: {
						policyCategory: "coding",
						resolve: () => [tool],
					},
				}),
		],
	});
	const [resolved] = await registry.resolve(undefined);
	if (resolved === undefined) {
		throw new Error("The registered JSON Schema tool was not resolved.");
	}
	const inputSchema = resolved.definition.inputSchema;
	if (!("jsonSchema" in inputSchema)) {
		throw new Error("The JSON Schema tool did not retain its schema type.");
	}
	const properties = inputSchema.jsonSchema.properties;
	if (!isObjectLike(properties)) {
		throw new Error("The nested JSON Schema properties were not retained.");
	}
	const pathSchema = Reflect.get(properties, "path");
	const snapshot = JSON.stringify(inputSchema.jsonSchema);

	expect(Object.isFrozen(inputSchema)).toBe(true);
	expect(Object.isFrozen(inputSchema.jsonSchema)).toBe(true);
	expect(Object.isFrozen(properties)).toBe(true);
	expect(Object.isFrozen(pathSchema)).toBe(true);

	sourceSchema.jsonSchema.properties.path.type = "number";
	expect(JSON.stringify(inputSchema.jsonSchema)).toBe(snapshot);
});

test("resolved tools form an immutable per-turn snapshot", async () => {
	const tool = resolvedTool("read");
	const registry = createApplicationToolRegistry<undefined>({
		providers: [
			(api) =>
				api.registerToolProvider({
					id: "coding",
					policyCategory: "coding",
					selectContext: (context) => context,
					adapter: {
						policyCategory: "coding",
						resolve: () => [tool],
					},
				}),
		],
	});

	const tools = await registry.resolve(undefined);

	expect(tools.map(({ definition: item }) => item.name)).toEqual(["read"]);
	expect(Object.isFrozen(tools)).toBe(true);
	expect(Object.isFrozen(tools[0])).toBe(true);
	expect(Object.isFrozen(tools[0]?.definition)).toBe(true);
});
