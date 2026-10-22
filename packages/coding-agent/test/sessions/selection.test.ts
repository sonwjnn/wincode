import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentId } from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry, RegistryAgent } from "@/modules/agents/registry";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	nextChatSelection,
	restorableSelectionModel,
	restoreSelection,
	sessionSelectionDefaults,
} from "@/modules/sessions/selection";
import { agentId, modelId, sessionMessageId } from "../support/identifiers";

const rowModel: ProviderModelSelection = {
	modelId: modelId("row-model"),
	providerId: "openai",
};
const messageModel: ProviderModelSelection = {
	modelId: modelId("message-model"),
	providerId: "openai",
};
const refsModel: ProviderModelSelection = {
	modelId: modelId("refs-model"),
	providerId: "openai",
};

const message = (
	id: string,
	metadata?: SessionMessage["metadata"]
): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		metadata,
		parts: [{ text: id, type: "text" }],
		role: "assistant",
	});

const messageWithSelection = (
	id: string,
	model: ProviderModelSelection,
	agent: AgentId = agentId("build"),
	thinkingLevel?: ThinkingLevel
): SessionMessage =>
	message(
		id,
		fromPartial<SessionMessage["metadata"]>({ agent, model, thinkingLevel })
	);

const registryWithPin = (
	pin: ProviderModelSelection | undefined,
	thinkingLevel?: ThinkingLevel
): AgentRegistry =>
	fromPartial<AgentRegistry>({
		agents: [
			fromPartial<RegistryAgent>({
				id: agentId("custom"),
				isAvailable: true,
				isSelectable: true,
				model: pin,
				role: "primary",
				thinkingLevel,
			}),
		],
		defaultAgentId: agentId("custom"),
	});

test("restores the session-row Model over the newest message pair", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", messageModel)],
		row: { model: rowModel },
	});

	expect(selection?.model).toEqual(rowModel);
	expect(selection?.source).toBe("row");
});

test("restores the newest message pair when the row carries no Model", () => {
	const selection = restoreSelection({
		messages: [
			messageWithSelection("old", refsModel),
			messageWithSelection("new", messageModel, agentId("review")),
		],
		row: {},
	});

	expect(selection?.model).toEqual(messageModel);
	expect(selection?.agent).toBe(agentId("review"));
	expect(selection?.source).toBe("message");
});

test("falls back to prompt-config refs only when no stored tier carries a Model", () => {
	const selection = restoreSelection({
		messages: [message("blank")],
		refs: { model: refsModel },
		row: {},
	});

	expect(selection?.model).toEqual(refsModel);
	expect(selection?.source).toBe("refs");
});

test("reports no restore when nothing was ever chosen", () => {
	const selection = restoreSelection({ messages: [message("blank")] });

	expect(selection).toBeNull();
});

test("merges Agent from message metadata only, never from the session row", () => {
	const selection = restoreSelection({
		messages: [message("blank")],
		row: { model: rowModel },
	});

	expect(selection?.model).toEqual(rowModel);
	expect(selection?.agent).toBeUndefined();
	expect(selection?.persistedAgent).toBeUndefined();
});

test("an unavailable recorded Agent restores as its replacement and keeps the recorded id", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", messageModel, agentId("removed"))],
		resolveAgent: () => agentId("build"),
	});

	expect(selection?.agent).toBe(agentId("build"));
	expect(selection?.persistedAgent).toBe(agentId("removed"));
});

test("restores the session-row Thinking level over the message's", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", rowModel, agentId("build"), "low")],
		row: { model: rowModel, thinkingLevel: "high" },
	});

	expect(selection?.thinkingLevel).toBe("high");
});

test("drops a Thinking level the schema rejects instead of failing the restore", () => {
	const selection = restoreSelection({
		messages: [
			messageWithSelection(
				"m1",
				messageModel,
				agentId("build"),
				"bogus" as ThinkingLevel
			),
		],
		row: { model: messageModel },
	});

	expect(selection?.model).toEqual(messageModel);
	expect(selection?.thinkingLevel).toBeUndefined();
});

test("keeps the last Thinking level recorded with the newest message Model", () => {
	const selection = restoreSelection({
		messages: [
			messageWithSelection("m1", messageModel, agentId("build"), "max"),
			messageWithSelection("m2", messageModel, agentId("build")),
		],
		row: { model: messageModel },
	});

	expect(selection?.thinkingLevel).toBe("max");
});

test("next-chat default reads the newest message pair alone when it exists", () => {
	const selection = nextChatSelection({
		messages: [messageWithSelection("m1", messageModel, agentId("review"))],
		row: { model: rowModel, thinkingLevel: "high" },
	});

	expect(selection?.model).toEqual(messageModel);
	expect(selection?.agent).toBe(agentId("review"));
});

test("next-chat default falls back to the stored tiers when no message pair exists", () => {
	const selection = nextChatSelection({
		messages: [message("blank")],
		row: { model: rowModel },
	});

	expect(selection?.model).toEqual(rowModel);
});

test("next-chat default reports nothing when no tier carries a Model", () => {
	expect(
		nextChatSelection({
			messages: [message("blank")],
		})
	).toBeNull();
});

test("defaults use the selected Agent's pinned Model when nothing is chosen", () => {
	expect(sessionSelectionDefaults(registryWithPin(rowModel), {}).model).toEqual(
		rowModel
	);
});

test("defaults keep an explicit Model over the Agent pin", () => {
	expect(
		sessionSelectionDefaults(registryWithPin(rowModel), { model: refsModel })
			.model
	).toEqual(refsModel);
});

test("defaults fall back to the product Agent and Model without a registry", () => {
	const defaults = sessionSelectionDefaults(null, {});

	expect(defaults.model).toEqual(DEFAULT_PROVIDER_MODEL_SELECTION);
	expect(defaults.agent).toBe(DEFAULT_AGENT_ID);
});

test("defaults reject an Agent selector that is not an identifier", () => {
	expect(() =>
		sessionSelectionDefaults(null, { agent: "Not An Agent" })
	).toThrow("Invalid Agent Identifier");
});

test("defaults take the Agent's own Thinking level", () => {
	expect(
		sessionSelectionDefaults(registryWithPin(rowModel, "medium"), {})
			.thinkingLevel
	).toBe("medium");
});

test("defaults keep an explicit Thinking level over the Agent's", () => {
	expect(
		sessionSelectionDefaults(registryWithPin(rowModel, "medium"), {
			thinkingLevel: "max",
		}).thinkingLevel
	).toBe("max");
});

test("a restored Model is restorable while the Agent pin still matches it", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", messageModel)],
	});

	expect(restorableSelectionModel(selection, { ...messageModel })).toEqual(
		messageModel
	);
});

test("a restored Model the Agent pin no longer matches is not restorable", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", messageModel)],
	});

	expect(restorableSelectionModel(selection, rowModel)).toBeUndefined();
});

test("a session with no restored Model never yields a restorable Model", () => {
	expect(restorableSelectionModel(null, rowModel)).toBeUndefined();
});

test("an Agent without a pinned Model never yields a restorable Model", () => {
	const selection = restoreSelection({
		messages: [messageWithSelection("m1", messageModel)],
	});

	expect(restorableSelectionModel(selection, undefined)).toBeUndefined();
});
