import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	getLastUsedSelection,
	getOriginatingUserSkill,
	resolveConversationSelection,
	resolveLastUsedConversationSelection,
	resolveOutgoingSelection,
} from "./selection";

describe("getLastUsedSelection", () => {
	test("returns metadata from the latest configured turn", () => {
		const messages = [
			{
				id: "user-1",
				metadata: {
					agent: "plan",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				},
				parts: [{ text: "first", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-1",
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.5", providerId: "openai" },
					variant: "high",
				},
				parts: [{ text: "latest", type: "text" }],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(getLastUsedSelection(messages)).toEqual({
			agent: "build",
			model: { modelId: "gpt-5.5", providerId: "openai" },
			variant: "high",
		});
	});

	test("skips invalid metadata and restores the latest valid selection", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: { agent: "plan", model: "bad-model" },
				parts: [{ text: "old", type: "text" }],
				role: "assistant",
			},
			{
				id: "assistant-2",
				metadata: {
					agent: "code-reviewer",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
					variant: "low",
				},
				parts: [{ text: "new", type: "text" }],
				role: "assistant",
			},
		] as unknown as CodingAgentUIMessage[];

		expect(getLastUsedSelection(messages)).toEqual({
			agent: "code-reviewer",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "low",
		});
	});

	test("scans back to the last message that carries a variant", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
					variant: "high",
				},
				parts: [{ text: "used high", type: "text" }],
				role: "assistant",
			},
			{
				id: "user-2",
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
					variant: undefined,
				},
				parts: [{ text: "continued", type: "text" }],
				role: "user",
			},
		] satisfies CodingAgentUIMessage[];

		expect(getLastUsedSelection(messages)).toEqual({
			agent: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "high",
		});
	});

	test("drops a variant that is not supported by the resolved model", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
					variant: "minimal",
				},
				parts: [{ text: "unsupported variant", type: "text" }],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(getLastUsedSelection(messages)).toEqual({
			agent: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: undefined,
		});
	});
});

describe("resolveConversationSelection", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;

	test("prefers the session-row variant over the message metadata variant", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: { agent: "build", model, variant: "high" },
				parts: [],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(
			resolveConversationSelection({
				messages,
				sessionModel: model,
				sessionVariant: "low",
			})
		).toMatchObject({ model, variant: "low" });
	});

	test("falls back to the message metadata variant when the session row has none", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: { agent: "build", model, variant: "high" },
				parts: [],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(
			resolveConversationSelection({ messages, sessionModel: model })
		).toMatchObject({ model, variant: "high" });
	});

	test("lets message metadata win over prompt-config refs", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: { agent: "build", model, variant: "high" },
				parts: [],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(
			resolveConversationSelection({
				messages,
				refs: { agent: "plan", model, variant: "low" },
			})
		).toMatchObject({ agent: "build", model, variant: "high" });
	});

	test("fills from refs when session and messages carry nothing", () => {
		expect(
			resolveConversationSelection({
				messages: [],
				refs: { agent: "build", model, variant: "high" },
			})
		).toEqual({
			agent: "build",
			persistedAgent: "build",
			model,
			variant: "high",
		});
	});

	test("resolves the agent through the injected resolver and keeps the persisted agent", () => {
		const messages = [
			{
				id: "assistant-1",
				metadata: { agent: "plan", model, variant: "high" },
				parts: [],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(
			resolveConversationSelection({
				messages,
				sessionModel: model,
				resolveAgent: () => "build",
			})
		).toMatchObject({ agent: "build", persistedAgent: "plan", model });
	});

	test("drops a session variant unsupported by the resolved model", () => {
		expect(
			resolveConversationSelection({
				messages: [],
				sessionModel: model,
				sessionVariant: "minimal",
			})
		).toMatchObject({ model, variant: undefined });
	});

	test("leaves agent undefined when no message selection and no refs", () => {
		expect(
			resolveConversationSelection({
				messages: [],
				sessionModel: model,
			})
		).toMatchObject({ agent: undefined, persistedAgent: undefined, model });
	});

	test("returns null when no source carries a model", () => {
		expect(resolveConversationSelection({ messages: [] })).toBeNull();
	});
});

describe("resolveLastUsedConversationSelection", () => {
	test("prefers the last message prompt config over a stale session row", () => {
		const sessionModel = {
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		} as const;
		const messageModel = {
			modelId: "gpt-5.5",
			providerId: "openai",
		} as const;
		const messages = [
			{
				id: "assistant-latest",
				metadata: {
					agent: "code-reviewer",
					model: messageModel,
					variant: "high",
				},
				parts: [{ text: "latest", type: "text" }],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(
			resolveLastUsedConversationSelection({
				messages,
				resolveAgent: (agent) => agent ?? "build",
				sessionModel,
				sessionVariant: "low",
			})
		).toEqual({
			agent: "code-reviewer",
			persistedAgent: "code-reviewer",
			model: messageModel,
			variant: "high",
		});
	});

	test("falls back to the session row without usable message metadata", () => {
		const sessionModel = {
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		} as const;

		expect(
			resolveLastUsedConversationSelection({
				messages: [],
				sessionModel,
				sessionVariant: "low",
			})
		).toEqual({
			agent: undefined,
			persistedAgent: undefined,
			model: sessionModel,
			variant: "low",
		});
	});
});

describe("resolveOutgoingSelection", () => {
	const model = { modelId: "gpt-5.4-mini", providerId: "wincode" } as const;
	const fallback = {
		agent: "build",
		model,
		variant: "high",
	} as const;

	test("uses most recent user skill when assistant is last", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model,
						skill: {
							name: "review",
							arguments: "focus",
							contentHash: "hash-review",
							instructions: "Review code",
							source: "explicit",
						},
					},
				},
				{
					id: "2",
					role: "assistant",
					parts: [],
					metadata: { agent: "build", model },
				},
			],
			fallback
		);

		expect(selection.skill).toEqual({
			name: "review",
			arguments: "focus",
			contentHash: "hash-review",
			instructions: "Review code",
			source: "explicit",
		});
	});

	test("uses skill snapshot on latest user message", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model,
						skill: {
							name: "plan",
							arguments: "",
							contentHash: "hash-plan",
							instructions: "Make a plan",
							source: "explicit",
						},
					},
				},
			],
			fallback
		);

		expect(selection.skill).toEqual({
			name: "plan",
			arguments: "",
			contentHash: "hash-plan",
			instructions: "Make a plan",
			source: "explicit",
		});
	});

	test("keeps undefined variant on latest metadata turn", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: "high",
					},
				},
				{
					id: "2",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: undefined,
					},
				},
			],
			fallback
		);

		expect(selection.variant).toBe("high");
	});

	test("prefers the last message metadata over the last valid metadata and fallback", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: { agent: "plan", model },
				},
				{
					id: "2",
					role: "user",
					parts: [],
					metadata: { agent: "code-reviewer", model },
				},
			],
			fallback
		);

		expect(selection).toMatchObject({
			agent: "code-reviewer",
			model,
			variant: "high",
		});
	});

	test("drops a malformed model pair from metadata", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model: JSON.parse('{"modelId":"gpt-5.4-mini"}'),
					},
				},
			],
			{ agent: "build", model }
		);

		expect(selection).toMatchObject({ agent: "build", model });
	});

	test("leaves the model undefined when metadata and fallback both lack one", () => {
		const selection = resolveOutgoingSelection(
			[
				{
					id: "1",
					role: "user",
					parts: [],
					metadata: {
						agent: "build",
						model: JSON.parse('{"modelId":"gpt-5.4-mini"}'),
					},
				},
			],
			undefined
		);

		expect(selection.model).toBeUndefined();
		expect(selection.agent).toBe("build");
	});

	test("rejects an empty message list", () => {
		expect(() => resolveOutgoingSelection([], fallback)).toThrow(
			"No message to send"
		);
	});
});

describe("getOriginatingUserSkill", () => {
	test("returns undefined when the originating user skill is sanitized", () => {
		const selection = getOriginatingUserSkill([
			{
				id: "1",
				role: "user",
				parts: [],
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
					skill: {
						arguments: "focus",
						contentHash: "hash-review",
						name: "review",
						source: "explicit",
					},
				},
			},
		]);

		expect(selection).toBeUndefined();
	});
});
