import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ProviderChatEvent, ProviderChatRequest } from "@wincode/ai";
import { buildAgentRegistry } from "@/modules/agents/registry";
import type {
	PluginAPI,
	PluginDefinitionAPI,
	PluginLoadContext,
	PluginProviderRegistration,
} from "@/modules/plugins/public";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import interactiveSmokePlugin from "../support/interactive-smoke-provider";

test("terminal smoke config selects an agent with only the read tool", async () => {
	const configPath = path.resolve(
		import.meta.dir,
		"../../../../scripts/test-support/interactive-smoke-wincode.json"
	);
	const document: unknown = await Bun.file(configPath).json();
	const projectConfig = document as Record<string, unknown>;
	expect(projectConfig.default_agent).toBe("terminal-smoke");
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: projectConfig,
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const agent = registry.agents.find(({ id }) => id === "terminal-smoke");

	expect(agent?.visibleCodingTools).toEqual(["read"]);
});

test("terminal smoke plugin uses the latest prompt after cancellation", async () => {
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "interactive-smoke-provider-")
	);
	const registrations: PluginProviderRegistration[] = [];
	const api = fromPartial<PluginAPI>({
		definePlugin: () =>
			fromPartial<PluginDefinitionAPI>({
				registerProvider: (registration: PluginProviderRegistration) => {
					registrations.push(registration);
				},
			}),
	});
	try {
		interactiveSmokePlugin(api, fromPartial<PluginLoadContext>({ workspace }));

		const registration = registrations[0];
		expect(registration?.providerId).toBe("terminal-smoke");
		expect(registration?.displayName).toBe("Interactive Smoke");
		if (registration === undefined) {
			throw new Error("The smoke Provider was not registered.");
		}

		const provider = registration.createProvider();
		expect(provider.models).toEqual([
			{
				capabilities: ["text", "tools"],
				modelId: "fake",
				protocolId: "fake-plugin-provider",
				providerId: "terminal-smoke",
			},
		]);
		expect(
			await provider.resolveAuthorization({ credential: undefined })
		).toEqual({ authorization: { kind: "local-test" } });

		const model = provider.models[0];
		if (model === undefined) {
			throw new Error("The smoke Provider model was not registered.");
		}
		const request: ProviderChatRequest = {
			messages: [
				{
					content: [{ text: "terminal smoke cancel", type: "text" }],
					role: "user",
				},
				{
					content: [{ text: "cancel-pending", type: "text" }],
					role: "assistant",
				},
				{
					content: [{ text: "terminal smoke after cancel", type: "text" }],
					role: "user",
				},
			],
		};
		const controller = new AbortController();
		controller.abort();
		const events: ProviderChatEvent[] = [];
		for await (const event of provider.streamChat(request, {
			authorization: { kind: "local-test" },
			headers: {},
			model,
			signal: controller.signal,
		})) {
			events.push(event);
		}
		expect(events).toEqual([
			{ delta: "after-cancel-ok", type: "text-delta" },
			{ type: "finish" },
		]);
	} finally {
		await fs.rm(workspace, { force: true, recursive: true });
	}
});
