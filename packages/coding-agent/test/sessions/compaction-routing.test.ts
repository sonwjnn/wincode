import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ChatRequest, ProviderModel } from "@wincode/ai";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { PluginProviderOwnerRegistration } from "@/modules/providers/provider-model-selection";
import { createSessionCompaction } from "@/modules/sessions/compaction/compaction";
import { resolveCompactionSettings } from "@/modules/sessions/compaction/config";
import type {
	CompactionLifecycle,
	SessionCompaction,
} from "@/modules/sessions/compaction/types";
import {
	type AgentSessionAdaptersOptions,
	createAgentSessionAdapters,
} from "@/modules/sessions/host/agent-session-adapters";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionUsageLedger } from "@/modules/sessions/usage/session-usage-ledger";
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
	reasoningEfforts: ["off", "low", "high"],
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
	} = { trusted: [], registered: [] },
	lifecycle?: CompactionLifecycle,
	contextWindowTokens?: number,
	reserveTokens = 1000,
	contextWindowModelOverrideTokens?: number
) => {
	const requests: ChatRequest[] = [];
	const persistedEntries: unknown[] = [];
	const summaryUsageEntries: unknown[] = [];
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
		compaction: {
			keepRecentTokens: 1,
			...(contextWindowModelOverrideTokens === undefined
				? {}
				: {
						modelOverrides: {
							"openai/chat": {
								contextWindowTokens: contextWindowModelOverrideTokens,
							},
						},
					}),
			reserveTokens,
			summary,
		},
		...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
	};
	const settings = resolveCompactionSettings({
		contextLimit: chatModel.limits?.contextWindowTokens,
		model: conversation,
		snapshot: {
			document,
			diagnostics: [],
			sources: [],
			sourceFor: () => undefined,
		},
	});
	const compaction = createSessionCompaction({
		...(lifecycle === undefined ? {} : { lifecycle }),
		store: {
			getLatestCompaction: async () => null,
			appendCompaction: async (input) => {
				persistedEntries.push(input);
				return {
					compaction: fromPartial<SessionCompaction>({
						...input,
						id: compactionId("routed"),
						sequence: 1,
					}),
					writeOutcome: {
						entryHash: "0".repeat(64),
						kind: "committed",
						operationId: "compaction-routed",
						projection: "ready",
						sequence: 1,
					},
				};
			},
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
			usageLedger: fromPartial<AgentSessionAdaptersOptions["usageLedger"]>({
				record: async (entry: Parameters<SessionUsageLedger["record"]>[0]) => {
					summaryUsageEntries.push(entry);
					return fromPartial({});
				},
			}),
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
	return {
		compact,
		requests,
		collection,
		persistedEntries,
		recorder,
		settings,
		summaryUsageEntries,
	};
};

test("Host routes only the summary to the configured model and preserves the chat retention budget", async () => {
	const { compact, requests, summaryUsageEntries } = fixture();
	const result = await compact();
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		providerId: "anthropic",
		modelId: "summary/large",
		maxOutputTokens: 512,
		reasoningEffort: "high",
	});
	expect(result.entry.summarizationModel).toEqual(summarizer);
	expect(result.entry.summarizationThinkingLevel).toBe("high");
	expect(summaryUsageEntries).toHaveLength(1);
	expect(summaryUsageEntries[0]).toMatchObject({
		kind: "compaction-summary",
		model: summarizer,
		usage: { inputTokens: 10, outputTokens: 2 },
	});
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

test("summary usage from an incomplete request keeps target identity without persisting a handoff", async () => {
	const { compact, persistedEntries, recorder, summaryUsageEntries } =
		fixture();
	recorder.stepScript = async function* () {
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
		yield {
			completion: { kind: "incomplete", reason: "output-limit" },
			type: "finish",
		};
	};

	await expect(compact()).rejects.toMatchObject({ code: "summary-failed" });
	expect(summaryUsageEntries).toHaveLength(1);
	expect(summaryUsageEntries[0]).toMatchObject({
		kind: "compaction-summary",
		model: summarizer,
		usage: { inputTokens: 10, outputTokens: 2 },
	});
	expect(persistedEntries).toHaveLength(0);
});

test("a conversation context override does not expand a different summary target", async () => {
	const constrainedSummaryModel: ProviderModel = {
		...summaryModel,
		limits: { contextWindowTokens: 1000, maxOutputTokens: 4096 },
	};
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large", maxOutputTokens: 512 },
		messages,
		constrainedSummaryModel,
		undefined,
		undefined,
		undefined,
		1000,
		500_000
	);

	await expect(compact()).rejects.toThrow(
		"The complete summary request leaves only 0 output tokens"
	);
	expect(requests).toHaveLength(0);
});

test("the conversation model's context override also applies when it is the summary target", async () => {
	const { compact, requests } = fixture(
		{},
		messages,
		undefined,
		undefined,
		undefined,
		undefined,
		1000,
		500_000
	);

	await expect(compact()).resolves.toBeDefined();
	expect(requests[0]).toMatchObject({ providerId: "openai", modelId: "chat" });
});

test("without a summary target the Host uses chat identity and inherits chat thinking", async () => {
	const { compact, requests } = fixture({}, shortHistory);
	const result = await compact();
	expect(requests[0]).toMatchObject({ providerId: "openai", modelId: "chat" });
	expect(requests[0]?.reasoningEffort).toBe("high");
	expect(result.entry.summarizationModel).toEqual(conversation);
	expect(result.entry.summarizationThinkingLevel).toBe("high");
});

test("a summary model that does not support the session thinking level fails before dispatch", async () => {
	const { compact, requests } = fixture(undefined, messages, {
		...summaryModel,
		reasoningEfforts: ["off", "low"],
	});
	await expect(compact()).rejects.toThrow(
		"does not support the active Session thinking level high"
	);
	expect(requests).toHaveLength(0);
});

for (const summary of [
	{ model: "not-an-identity" },
	{ model: "anthropic/summary/large", maxOutputTokens: 0 },
	{ model: "anthropic/summary/large", thinkingLevel: "low" },
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

test("uses Provider output metadata when the summary target has no configured ceiling", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
		}
	);

	await compact();
	expect(requests[0]?.maxOutputTokens).toBe(512);
});

test("uses the 32,000-token application default without Provider output metadata", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{ ...summaryModel, limits: { contextWindowTokens: 200_000 } },
		{ trusted: [], registered: [] },
		undefined,
		200_000,
		50_000
	);

	await compact();
	expect(requests[0]?.maxOutputTokens).toBe(32_000);
});

test("summary output is capped at 80% of the conversation reserve", async () => {
	const { compact, requests } = fixture({ model: "anthropic/summary/large" });
	await compact();
	expect(requests[0]?.maxOutputTokens).toBe(800);
});

test("the conversation reserve caps a large-output summary model below its declared limit", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
		},
		{ trusted: [], registered: [] },
		undefined,
		200_000
	);
	await compact();
	expect(requests[0]?.maxOutputTokens).toBe(800);
});

test("an invocable summary credential can compact without a provider-enforced output cap", async () => {
	const { compact, requests, collection } = fixture();
	collection.canEnforceMaxOutputTokens = async () => false;
	await expect(compact()).resolves.toBeDefined();
	expect(requests).toHaveLength(1);
	expect(requests[0]).not.toHaveProperty("maxOutputTokens");
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

test("a summary target whose trusted owner changes before dispatch is not replaced or persisted", async () => {
	const trustedOwners: PluginProviderOwnerRegistration[] = [customOwner];
	const { compact, requests, persistedEntries } = fixture(
		{ model: "custom/summary" },
		messages,
		{ ...summaryModel, providerId: "custom", modelId: "summary" },
		{ trusted: trustedOwners, registered: [customOwner] },
		{
			before: async () => {
				trustedOwners[0] = {
					...customOwner,
					sourceIdentity: "/replacement/summary-plugin.ts",
				};
				return;
			},
		}
	);

	await expect(compact()).rejects.toMatchObject({ code: "summary-failed" });
	expect(requests).toHaveLength(0);
	expect(persistedEntries).toHaveLength(0);
});

test("a Plugin owner change during async availability is rejected before dispatch", async () => {
	const trustedOwners: PluginProviderOwnerRegistration[] = [customOwner];
	const { compact, requests, collection, persistedEntries } = fixture(
		{ model: "custom/summary" },
		messages,
		{ ...summaryModel, providerId: "custom", modelId: "summary" },
		{ trusted: trustedOwners, registered: [customOwner] }
	);
	const getAvailable = collection.getAvailable.bind(collection);
	let availabilityChecks = 0;
	collection.getAvailable = async (providerId) => {
		const available = await getAvailable(providerId);
		if (providerId === "custom" && ++availabilityChecks === 2) {
			trustedOwners[0] = {
				...customOwner,
				sourceIdentity: "/replacement/summary-plugin.ts",
			};
		}
		return available;
	};

	await expect(compact()).rejects.toMatchObject({ code: "summary-failed" });
	expect(requests).toHaveLength(0);
	expect(persistedEntries).toHaveLength(0);
});

test("a summary target revoked before dispatch is not replaced or persisted", async () => {
	let revoked = false;
	const { compact, requests, collection, persistedEntries } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		summaryModel,
		{ trusted: [], registered: [] },
		{
			before: async () => {
				revoked = true;
				return;
			},
		}
	);
	const getAvailable = collection.getAvailable.bind(collection);
	collection.getAvailable = async (providerId) =>
		revoked ? [] : getAvailable(providerId);

	await expect(compact()).rejects.toMatchObject({ code: "summary-failed" });
	expect(requests).toHaveLength(0);
	expect(persistedEntries).toHaveLength(0);
});

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

test("an explicit global override overrides a smaller summary-model context declaration", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 4000, maxOutputTokens: 4096 },
		},
		{ trusted: [], registered: [] },
		undefined,
		200_000
	);

	await expect(compact()).resolves.toBeDefined();
	expect(requests).toHaveLength(1);
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

test("summary budgeting uses the summary model's metadata when no override is set", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 4000, maxOutputTokens: 4096 },
		}
	);

	await expect(compact()).rejects.toBeDefined();
	expect(requests).toHaveLength(0);
});

test("invalid summary-model context metadata uses the 272k fallback", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{
			...summaryModel,
			limits: { contextWindowTokens: 0, maxOutputTokens: 4096 },
		}
	);

	await expect(compact()).resolves.toBeDefined();
	expect(requests).toHaveLength(1);
});

test("a summary model without context metadata uses the 272k fallback", async () => {
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		{ ...summaryModel, limits: {} }
	);

	await expect(compact()).resolves.toBeDefined();
	expect(requests).toHaveLength(1);
});

test("a Plugin summary compacts even when the summary target cannot enforce an output cap", async () => {
	const { compact, requests, collection } = fixture(
		{},
		messages,
		summaryModel,
		{ trusted: [], registered: [] },
		{ before: async () => ({ summary: "Plugin handoff for OAuth users." }) }
	);
	// The target stays invocable, so the deferred failure is the output-cap one.
	collection.canEnforceMaxOutputTokens = async () => false;

	const result = await compact();

	// No summary request is dispatched, and the committed handoff is the Plugin's.
	expect(requests).toHaveLength(0);
	expect(result.entry.summary.text).toContain(
		"Plugin handoff for OAuth users."
	);
});

test("a Plugin summary does not mask an unauthenticated configured target", async () => {
	const { compact, requests, collection } = fixture(
		{},
		messages,
		summaryModel,
		{ trusted: [], registered: [] },
		{
			before: async () => ({ summary: "Plugin handoff without a credential." }),
		}
	);
	collection.getAvailable = async () => [];

	// A broken configured target stays visible; only the output-cap limitation
	// is replaceable by a Plugin handoff.
	await expect(compact()).rejects.toMatchObject({
		code: "summary-failed",
		message: expect.stringContaining("not invocable"),
	});
	expect(requests).toHaveLength(0);
});

test("a Plugin handoff is not limited by the generated summary prompt room", async () => {
	const handoff = `Plugin handoff. ${"detail ".repeat(50)}`.trim();
	const { compact, requests } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		summaryModel,
		{ trusted: [], registered: [] },
		{ before: async () => ({ summary: handoff }) }
	);

	const result = await compact();

	// The oversized shared history exhausts the generation prompt budget, but
	// a host-owned handoff needs no summary request and still fits the reserve.
	expect(requests).toHaveLength(0);
	expect(result.entry.summary.text).toContain("Plugin handoff.");
});

test("without a Plugin summary an invocable uncapped target generates a handoff", async () => {
	const { compact, requests, collection } = fixture(
		{ model: "anthropic/summary/large" },
		messages,
		summaryModel
	);
	collection.canEnforceMaxOutputTokens = async () => false;

	const result = await compact();
	expect(result.entry.summary.text).not.toBeEmpty();
	expect(requests).toHaveLength(1);
	expect(requests[0]).not.toHaveProperty("maxOutputTokens");
});

test("a Plugin-supplied summary has no Provider thinking level", async () => {
	const { compact, collection } = fixture(
		{},
		messages,
		summaryModel,
		{ trusted: [], registered: [] },
		{ before: async () => ({ summary: "Plugin handoff." }) }
	);
	collection.canEnforceMaxOutputTokens = async () => false;

	const result = await compact();

	// No Provider request ran, so there is no summarization thinking level to record.
	expect(result.entry.summarizationThinkingLevel).toBeUndefined();
});
