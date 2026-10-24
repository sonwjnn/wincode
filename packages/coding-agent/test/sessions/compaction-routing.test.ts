import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ChatRequest, ProviderModel } from "@wincode/ai";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { PluginProviderOwnerRegistration } from "@/modules/providers/provider-model-selection";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import { resolveCompactionSettings } from "@/modules/sessions/compaction/config";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import {
	type AgentSessionAdaptersOptions,
	createAgentSessionAdapters,
} from "@/modules/sessions/host/agent-session-adapters";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	compactionId,
	providerModelSelectionFixture,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";

const conversation = providerModelSelectionFixture("openai/chat");
const summarizer = providerModelSelectionFixture("anthropic/summary/large");
const chatModel: ProviderModel = {
	...conversation,
	protocolId: "fixture",
	limits: { contextWindowTokens: 8000 },
	reasoningEfforts: ["high"],
};
const summaryModel: ProviderModel = {
	...summarizer,
	protocolId: "fixture",
	limits: { contextWindowTokens: 200_000, maxOutputTokens: 4096 },
	reasoningEfforts: ["off", "low"],
};
const messages: SessionMessage[] = (
	[
		["first-user", "user", "old request ".repeat(4000)],
		["first-answer", "assistant", "old answer ".repeat(4000)],
		["last-user", "user", "keep this request"],
		["last-answer", "assistant", "keep this answer"],
	] as const
).map(([id, role, text]) =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		role,
		parts: [{ type: "text", text }],
	})
);

const fixture = (
	summary: unknown = { model: "anthropic/summary/large", maxOutputTokens: 512 },
	sourceMessages = messages,
	targetModel = summaryModel,
	owners: {
		trusted: readonly PluginProviderOwnerRegistration[];
		registered: readonly PluginProviderOwnerRegistration[];
	} = { trusted: [], registered: [] }
) => {
	const requests: ChatRequest[] = [];
	const recorder = createFakeProviderRecorder();
	const baseCollection = createFakeProviderCollection(recorder, chatModel, [
		targetModel,
	]);
	const collection = {
		...baseCollection,
		getPluginProviderRegistrations: () => owners.registered,
		chat: (request: ChatRequest) => {
			requests.push(request);
			return baseCollection.chat(request);
		},
	};
	const document = {
		compaction: { keepRecentTokens: 1, reserveTokens: 1000, summary },
	};
	const settings = resolveCompactionSettings({
		contextLimit: 8000,
		model: conversation,
		snapshot: {
			document,
			diagnostics: [],
			sources: [],
			sourceFor: () => undefined,
		},
	});
	const compaction = createSessionCompaction({
		store: {
			getLatestCompaction: async () => null,
			appendCompaction: async (input) =>
				fromPartial<SessionCompaction>({
					...input,
					id: compactionId("routed"),
					sequence: 1,
				}),
		},
	});
	const adapters = createAgentSessionAdapters(
		fromPartial<AgentSessionAdaptersOptions>({
			capabilities: {
				getCapabilityCeiling: () => undefined,
				getCompactionModule: () => compaction,
				getPluginRuntime: () =>
					fromPartial<PluginRuntime>({
						getProviderRegistrations: () => owners.trusted,
					}),
			},
			providerCollection: collection,
			sessionId: sessionId("routing"),
			isShutDown: () => false,
		})
	);
	const compact = () =>
		adapters.compaction.compact({
			model: conversation,
			thinkingLevel: "high",
			session: { sessionId: sessionId("routing"), messages: sourceMessages },
			settings: { ...settings, compactionOverheadTokens: 256 },
			trigger: "manual",
		});
	return { compact, requests, collection, settings };
};

test("Host routes only the summary to the configured model and preserves the chat retention budget", async () => {
	const { compact, requests } = fixture();
	const result = await compact();
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		providerId: "anthropic",
		modelId: "summary/large",
		maxOutputTokens: 512,
		reasoningEffort: "off",
	});
	expect(result.entry.summarizationModel).toEqual(summarizer);
	expect(result.entry.summarizationThinkingLevel).toBe("off");
	expect(result.activeMessages.slice(1).map((message) => message.id)).toEqual([
		sessionMessageId("last-user"),
		sessionMessageId("last-answer"),
	]);
});

const shortHistory = messages.map((message) => ({
	...message,
	parts: [
		{ type: "text" as const, text: "short historical content ".repeat(30) },
	],
}));

test("without a summary target the Host uses chat identity but does not inherit chat thinking", async () => {
	const { compact, requests } = fixture({}, shortHistory);
	const result = await compact();
	expect(requests[0]).toMatchObject({ providerId: "openai", modelId: "chat" });
	expect(requests[0]?.reasoningEffort).toBeUndefined();
	expect(result.entry.summarizationModel).toEqual(conversation);
	expect(result.entry.summarizationThinkingLevel).toBeUndefined();
});

test("an explicit summary thinking level is dispatched and persisted independently", async () => {
	const { compact, requests } = fixture({
		model: "anthropic/summary/large",
		thinkingLevel: "low",
		maxOutputTokens: 512,
	});
	const result = await compact();
	expect(requests[0]?.reasoningEffort).toBe("low");
	expect(result.entry.summarizationThinkingLevel).toBe("low");
});

for (const summary of [
	{ model: "not-an-identity" },
	{ model: "anthropic/summary/large", maxOutputTokens: 0 },
	{ model: "anthropic/summary/large", thinkingLevel: "unlimited" },
	{ model: "anthropic/summary/large", typo: true },
	null,
]) {
	test(`invalid summary configuration fails without a fallback request: ${JSON.stringify(summary)}`, async () => {
		const { compact, requests } = fixture(summary);
		await expect(compact()).rejects.toThrow("Invalid compaction.summary");
		expect(requests).toHaveLength(0);
	});
}

test("an unknown configured summary target fails rather than dispatching to chat", async () => {
	const { compact, requests } = fixture({ model: "anthropic/missing" });
	await expect(compact()).rejects.toThrow("unavailable");
	expect(requests).toHaveLength(0);
});

test("an unauthenticated summary provider dispatches nothing without falling back", async () => {
	const { compact, requests, collection } = fixture();
	collection.getAvailable = async () => [];
	await expect(compact()).rejects.toThrow("not invocable");
	expect(requests).toHaveLength(0);
});

test("a summary credential that cannot enforce the output cap dispatches nothing", async () => {
	const { compact, requests, collection } = fixture();
	collection.canEnforceMaxOutputTokens = async () => false;
	await expect(compact()).rejects.toThrow("cannot enforce");
	expect(requests).toHaveLength(0);
});

test("an ownerless custom summary provider is rejected before dispatch", async () => {
	const { compact, requests } = fixture({ model: "custom/summary" }, messages, {
		...summaryModel,
		providerId: "custom",
		modelId: "summary",
	});
	await expect(compact()).rejects.toThrow("not bound to its trusted source");
	expect(requests).toHaveLength(0);
});

const customOwner = {
	providerId: "custom",
	pluginId: "summary-plugin",
	sourceIdentity: "/trusted/summary-plugin.ts",
};

test("an explicitly selected custom summary target captures and persists its trusted Plugin owner", async () => {
	const { compact, requests } = fixture(
		{ model: "custom/summary" },
		messages,
		{ ...summaryModel, providerId: "custom", modelId: "summary" },
		{ trusted: [customOwner], registered: [customOwner] }
	);
	const result = await compact();
	expect(requests[0]).toMatchObject({
		providerId: "custom",
		modelId: "summary",
	});
	expect(result.entry.summarizationModel).toEqual({
		...providerModelSelectionFixture("custom/summary"),
		pluginProviderSource: {
			pluginId: "summary-plugin",
			sourceIdentity: "/trusted/summary-plugin.ts",
		},
	});
});

test("a summary Plugin owner mismatch rejects the configured target without dispatch", async () => {
	const { compact, requests } = fixture(
		{ model: "custom/summary" },
		messages,
		{ ...summaryModel, providerId: "custom", modelId: "summary" },
		{
			trusted: [customOwner],
			registered: [{ ...customOwner, sourceIdentity: "/replacement.ts" }],
		}
	);
	await expect(compact()).rejects.toThrow("not bound to its trusted source");
	expect(requests).toHaveLength(0);
});

test("an unsupported explicit summary thinking level is rejected rather than silently dropped", async () => {
	const { compact, requests } = fixture({
		model: "anthropic/summary/large",
		thinkingLevel: "max",
	});
	await expect(compact()).rejects.toThrow("does not support thinkingLevel max");
	expect(requests).toHaveLength(0);
});

test("the summary target's smaller window rejects an oversized prompt before dispatch", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{ ...summaryModel, limits: { contextWindowTokens: 4000 } }
	);
	await expect(compact()).rejects.toMatchObject({
		code: "context-still-too-large",
	});
	expect(requests).toHaveLength(0);
});

test("a summary target's output cap below the minimum dispatches nothing", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large", maxOutputTokens: 512 },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 200_000, maxOutputTokens: 128 },
		}
	);
	await expect(compact()).rejects.toMatchObject({
		code: "context-still-too-large",
	});
	expect(requests).toHaveLength(0);
});

test("an unknown summary context window fails before dispatch instead of borrowing chat limits", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{ ...summaryModel, limits: {} }
	);
	await expect(compact()).rejects.toThrow(
		"context-window limit is unavailable"
	);
	expect(requests).toHaveLength(0);
});
