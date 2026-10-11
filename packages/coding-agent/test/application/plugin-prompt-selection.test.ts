import { expect, test } from "bun:test";
import type {
	ConnectionProviderSummary,
	Connections,
} from "@wincode/ai/connections";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
} from "@wincode/ai/models";
import { createPluginPromptSelectionTarget } from "@/modules/application/plugin-prompt-selection";

const connectedProvider: ConnectionProviderSummary = {
	connected: true,
	connectionMethod: "api-key",
	displayName: "OpenAI",
	id: "openai",
	methods: ["api-key"],
};

const disconnectedProvider: ConnectionProviderSummary = {
	connected: false,
	displayName: "OpenAI",
	id: "openai",
	methods: ["api-key"],
};

const connectionsFor = (
	providers: readonly ConnectionProviderSummary[]
): Pick<Connections, "listProviders"> => ({
	listProviders: async () => providers,
});

test("the focused composer rejects a model whose provider is disconnected", async () => {
	const selectedModels: ChatModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(
		connectionsFor([disconnectedProvider]),
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		}
	);

	await expect(target.setModel(defaultChatModelSelection)).resolves.toBe(false);
	expect(selectedModels).toEqual([]);
});

test("the focused composer accepts an active model from a connected provider", async () => {
	const selectedModels: ChatModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(
		connectionsFor([connectedProvider]),
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		}
	);

	await expect(target.setModel(defaultChatModelSelection)).resolves.toBe(true);
	expect(selectedModels).toEqual([defaultChatModelSelection]);
});
