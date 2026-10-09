import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentTurnId } from "@wincode/agent-core";
import type {
	PluginBeforeAgentTurnContext,
	PluginSessionContext,
} from "@wincode/coding-agent";
import { loadPlugins } from "@/modules/plugins/loader";
import { createConfigStore } from "@/shared/config/config-store";
import { agentId, sessionId } from "../../support/identifiers";

test("the distributed Subagents package registers delegate through the public Plugin contract", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "wincode-subagents-plugin-")
	);
	const databasePath = path.join(root, "subagents.sqlite");
	const previousDatabasePath = process.env.WINCODE_SUBAGENTS_DB_PATH;
	process.env.WINCODE_SUBAGENTS_DB_PATH = databasePath;
	const configStore = createConfigStore({ configRoot: root, homeRoot: root });
	const workspace = path.join(root, "workspace");
	const runtime = await loadPlugins({
		cliPaths: [],
		config: { configStore, cwd: workspace, homeRoot: root, workspace },
		distributionPlugins: [
			{ id: "subagents", specifier: "@wincode/subagents/plugin" },
		],
		userDataDir: path.join(root, "user-data"),
	});
	const context = fromPartial<PluginBeforeAgentTurnContext>({
		agentId: agentId("build"),
		sessionId: sessionId("parent-session"),
		sessionSdk: {
			getAgentCatalog: async () => [
				{
					description: "Explore the codebase.",
					id: agentId("scout"),
					isAvailable: true,
					role: "subagent",
				},
				{
					description: "Research with web sources.",
					id: agentId("researcher"),
					isAvailable: false,
					role: "subagent",
					unavailableReason: "Missing required child tools: web_search",
				},
			],
		},
		signal: new AbortController().signal,
		turnId: "plugin-turn" as AgentTurnId,
		workspace,
	});
	try {
		const registeredAgentIds = runtime
			.getAgentRegistrations()
			.map(({ agent }) => String(agent.id))
			.toSorted();
		expect(registeredAgentIds).toEqual([
			"delegate",
			"evidence-auditor",
			"oracle",
			"researcher",
			"reviewer",
			"scout",
			"worker",
		]);

		const sessionContext = fromPartial<PluginSessionContext>({
			sessionId: context.sessionId,
			sessionSdk: context.sessionSdk,
			workspace,
		});
		await runtime.startSession(sessionContext);
		const commandOutput = await runtime.executeCommand(
			"subagents",
			"subagents",
			{ argument: "", sessionId: context.sessionId, workspace }
		);
		expect(commandOutput).toContain(
			"- researcher — unavailable: Missing required child tools: web_search"
		);
		expect(commandOutput).toContain("- scout — available");

		const tools = await runtime.resolveToolsForTurn(context);
		expect(tools.map(({ name }) => name)).toContain("delegate");
	} finally {
		await runtime.shutdown();
		if (previousDatabasePath === undefined) {
			delete process.env.WINCODE_SUBAGENTS_DB_PATH;
		} else {
			process.env.WINCODE_SUBAGENTS_DB_PATH = previousDatabasePath;
		}
		await rm(root, { force: true, recursive: true });
	}
});
