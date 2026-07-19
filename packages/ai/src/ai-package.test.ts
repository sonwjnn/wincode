import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
	codingMessageMetadataSchema,
	codingModeNames,
	codingModes,
	codingToolDefinitions,
	codingToolSchemas,
	defaultChatModel,
	defaultChatModelSelection,
	defaultMode,
	expandFileMentionPartsForModel,
	findSupportedChatModel,
	getNextCodingModeName,
	getSystemInstructions,
	parseMode,
	type ReadInput,
	type ReadOutput,
	sanitizeInterruptedMessagesForModel,
	supportedChatModelIds,
	supportedChatModels,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
import type { FileUIPart } from "ai";
import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	safeValidateUIMessages,
} from "ai";
import {
	type CodingAgentModelUIMessage,
	restoreOriginalFileMentionParts,
} from "./file-mentions";
import { createCodingAgent } from "./server/agent";
import { resolveOpenAIChatModel as facadeResolveOpenAIChatModel } from "./server/index";
import { codingServerTools } from "./server/tools";
import { codingToolRunners } from "./tools/runners";

describe("@wincode/ai shared entry", () => {
	test("exports the coding tool registry as the shared tool Interface", () => {
		expect(Object.keys(codingToolDefinitions)).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"grep",
		]);

		for (const definition of Object.values(codingToolDefinitions)) {
			expect(definition.description.length).toBeGreaterThan(0);
			expect(definition.inputSchema).toBeDefined();
			expect(definition.outputSchema).toBeDefined();
		}
	});

	test("exports Zod-only coding tool schemas", () => {
		expect(Object.keys(codingToolSchemas)).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"grep",
		]);

		for (const schema of Object.values(codingToolSchemas)) {
			expect(schema.description.length).toBeGreaterThan(0);
			expect(schema.schema).toBeDefined();
			expect("execute" in schema).toBe(false);
			expect("runtime" in schema).toBe(false);
		}
	});

	test("creates user messages", () => {
		expect(createUserMessage("hello")).toMatchObject({
			parts: [{ text: "hello", type: "text" }],
			role: "user",
		});
	});

	test("creates user messages with chat metadata", () => {
		expect(
			createUserMessage("hello", {
				mode: "plan",
				model: {
					modelId: "gpt-5.4-mini",
					providerId: "wincode",
				},
			})
		).toMatchObject({
			metadata: {
				mode: "plan",
				model: {
					modelId: "gpt-5.4-mini",
					providerId: "wincode",
				},
			},
			parts: [{ text: "hello", type: "text" }],
			role: "user",
		});
	});

	test("creates user messages with file mention data", () => {
		expect(
			createUserMessage("hello @README.md", undefined, [
				{
					data: {
						byteLength: 5,
						content: "hello",
						kind: "file",
						path: "README.md",
						truncated: false,
					},
					type: "data-fileMention",
				},
			])
		).toMatchObject({
			parts: [
				{ text: "hello @README.md", type: "text" },
				{
					data: {
						content: "hello",
						path: "README.md",
					},
					type: "data-fileMention",
				},
			],
			role: "user",
		});
	});

	test("creates user messages in text, mention, then pasted file order", () => {
		const mention = {
			data: {
				byteLength: 5,
				content: "hello",
				kind: "file" as const,
				path: "README.md",
				truncated: false,
			},
			type: "data-fileMention" as const,
		};
		const file = {
			mediaType: "text/plain",
			type: "file",
			url: "data:text/plain;base64,aGVsbG8=",
		} satisfies FileUIPart;

		expect(
			createUserMessage("hello", undefined, [mention], [file]).parts
		).toEqual([{ text: "hello", type: "text" }, mention, file]);
	});

	test("expands file mention data for model context", () => {
		const [message] = expandFileMentionPartsForModel([
			createUserMessage("hello @README.md", undefined, [
				{
					data: {
						byteLength: 5,
						content: "hello",
						kind: "file",
						path: "README.md",
						truncated: false,
					},
					type: "data-fileMention",
				},
			]),
		]);

		expect(message?.parts).toEqual([
			{ text: "hello @README.md", type: "text" },
			{
				text: [
					"Referenced file mention:",
					"Path: README.md",
					"Kind: file",
					"Truncated: no",
					"Content:",
					"hello",
				].join("\n"),
				type: "text",
			},
		]);
	});

	test("removes cancelled OpenAI item metadata from interrupted assistant history", () => {
		const [message] = sanitizeInterruptedMessagesForModel([
			{
				id: "assistant-1",
				metadata: { interrupted: true },
				parts: [
					{
						providerMetadata: { openai: { itemId: "msg_cancelled" } },
						text: "Partial response",
						type: "text",
					},
				],
				role: "assistant",
			},
		]);

		expect(message?.parts).toEqual([
			{ text: "Partial response", type: "text" },
		]);
	});

	test("restores original file mention parts without discarding continuation updates", () => {
		const originalUserMessage = createUserMessage(
			"hello @README.md",
			undefined,
			[
				{
					data: {
						byteLength: 5,
						content: "hello",
						kind: "file",
						path: "README.md",
						truncated: false,
					},
					type: "data-fileMention",
				},
			]
		);
		const originalAssistantMessage: CodingAgentUIMessage = {
			id: "assistant-1",
			parts: [{ text: "old", type: "text" }],
			role: "assistant",
		};
		const continuedAssistantMessage: CodingAgentModelUIMessage = {
			...originalAssistantMessage,
			parts: [{ text: "old new", type: "text" as const }],
		};
		const expectedContinuedAssistantMessage: CodingAgentUIMessage = {
			...originalAssistantMessage,
			parts: [{ text: "old new", type: "text" }],
		};

		expect(
			restoreOriginalFileMentionParts(
				[
					...expandFileMentionPartsForModel([originalUserMessage]),
					continuedAssistantMessage,
				],
				[originalUserMessage, originalAssistantMessage]
			)
		).toEqual([originalUserMessage, expectedContinuedAssistantMessage]);
	});

	test("validates file mention data parts", async () => {
		const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
			dataSchemas: codingAgentDataSchemas,
			messages: [
				createUserMessage("hello @README.md", undefined, [
					{
						data: {
							byteLength: 5,
							content: "hello",
							kind: "file",
							path: "README.md",
							truncated: false,
						},
						type: "data-fileMention",
					},
				]),
			],
		});

		expect(validation.success).toBe(true);
	});

	test("validates standard file UI parts", async () => {
		const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
			dataSchemas: codingAgentDataSchemas,
			messages: [
				createUserMessage(
					"attached",
					undefined,
					[],
					[
						{
							mediaType: "text/plain",
							type: "file",
							url: "data:text/plain;base64,aGVsbG8=",
						},
					]
				),
			],
		});

		expect(validation.success).toBe(true);
	});

	test("validates coding message metadata", () => {
		expect(
			codingMessageMetadataSchema.safeParse({
				mode: "plan",
				model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
				responseTimeMs: 12,
				variant: "high",
			}).success
		).toBe(true);
		expect(
			codingMessageMetadataSchema.safeParse({
				mode: "plan",
				model: { modelId: "gemini-2.5-flash", providerId: "wincode" },
				variant: "minimal",
			}).success
		).toBe(false);
	});

	test("accepts legacy model aliases and preserves default wincode selection", () => {
		expect(
			codingMessageMetadataSchema.safeParse({
				model: "gemini-3.5-flash",
			}).success
		).toBe(true);
		expect(
			codingMessageMetadataSchema.parse({
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			})
		).toEqual({ model: { modelId: "gpt-5.4-mini", providerId: "wincode" } });
	});

	test("defines supported chat models by provider", () => {
		expect(defaultChatModel.value).toBe("gpt-5.4-mini");
		expect(defaultChatModelSelection).toEqual({
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		});
		expect(supportedChatModelIds).toHaveLength(56);
		expect(supportedChatModelIds).toEqual(
			expect.arrayContaining([
				"gpt-5.6-terra",
				"claude-opus-4-8",
				"gemini-3.5-flash",
				"gemma-4-31b-it",
			])
		);
		expect(new Set(supportedChatModels.map((model) => model.provider))).toEqual(
			new Set(["anthropic", "google", "openai"])
		);
		expect(findSupportedChatModel("gemini-2.5-flash")).toMatchObject({
			id: "gemini-2.5-flash",
			provider: "google",
		});
		expect(findSupportedChatModel("unknown-model")).toBeNull();
	});

	test("defines ordered coding modes", () => {
		expect(defaultMode.value).toBe("build");
		expect(codingModes.map((mode) => mode.value)).toEqual([...codingModeNames]);
		expect(codingModes.map((mode) => mode.value)).toEqual(["build", "plan"]);
		expect(getNextCodingModeName("build")).toBe("plan");
		expect(getNextCodingModeName("plan")).toBe("build");
	});

	test("parses persisted coding modes safely", () => {
		expect(parseMode("plan")).toBe("plan");
		expect(parseMode("unknown")).toBe(defaultMode.value);
	});

	test("composes mode-specific system instructions", () => {
		expect(getSystemInstructions("build")).toContain(
			"Purpose: implement requested code changes"
		);
		expect(getSystemInstructions("plan")).toContain(
			"read-only analysis and implementation planning"
		);
		expect(getSystemInstructions("plan")).toContain("Do not modify files");
	});

	test("exports the coding UI message type from the shared entry", () => {
		const message: CodingAgentUIMessage = createUserMessage("hello");

		expect(message.role).toBe("user");
	});
});

describe("@wincode/ai server and client entries", () => {
	test("server facade exports OpenAI model resolver", () => {
		expect(typeof facadeResolveOpenAIChatModel).toBe("function");
	});
	test("server entry exports the coding agent", () => {
		const codingAgent = createCodingAgent({
			model: {} as never,
		});

		expect(codingAgent.tools).toBeDefined();
		expect(Object.keys(codingAgent.tools ?? {})).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"grep",
		]);
	});

	test("client entry exports a typed tool-call handler", () => {
		expect(typeof handleCodingAgentToolCall).toBe("function");
	});

	test("plan mode blocks write tool execution", async () => {
		const emittedOutputs: Parameters<
			ChatAddToolOutputFunction<CodingAgentUIMessage>
		>[0][] = [];
		const addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage> = (
			output
		) => {
			emittedOutputs.push(output);
		};
		const toolCallOptions = {
			toolCall: {
				dynamic: false,
				input: { content: "hello", path: "README.md" },
				toolCallId: "call_1",
				toolName: "write",
			},
		} satisfies Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0];

		await handleCodingAgentToolCall(addToolOutput, "plan")(toolCallOptions);

		expect(emittedOutputs).toEqual([
			{
				errorText: "Plan mode cannot use write.",
				state: "output-error",
				tool: "write",
				toolCallId: "call_1",
			},
		]);
	});

	test("tool mirrors are complete for the registry", () => {
		const registryKeys = Object.keys(codingToolDefinitions);

		expect(Object.keys(codingToolRunners)).toEqual(registryKeys);
		expect(Object.keys(codingServerTools)).toEqual(registryKeys);
	});
});

describe("type-safety contract", () => {
	test("keeps read input and output linked", () => {
		const input: ReadInput = { path: "README.md" };
		const output: ReadOutput = { content: "hello", path: "README.md" };

		expect(input.path).toBe("README.md");
		expect(output.content).toBe("hello");
	});

	test("keeps UI message type exported", () => {
		const message: CodingAgentUIMessage = createUserMessage("hello");

		expect(message.role).toBe("user");
	});

	test("rejects incorrect type pairings at compile time", () => {
		// @ts-expect-error read input does not accept file content.
		const invalidInput: ReadInput = { content: "wrong", path: "README.md" };

		expect(invalidInput.path).toBe("README.md");
	});
});

describe("type-safety guardrails", () => {
	test("client and server avoid erased dynamic tool maps", async () => {
		const [clientSource, serverSource, serverToolsSource] = await Promise.all([
			readFile(new URL("./client.ts", import.meta.url), "utf8"),
			readFile(new URL("./server/index.ts", import.meta.url), "utf8"),
			readFile(new URL("./server/tools.ts", import.meta.url), "utf8"),
		]);

		for (const source of [clientSource, serverSource, serverToolsSource]) {
			expect(source).not.toContain(": any");
			expect(source).not.toContain("as any");
			expect(source).not.toContain("Object.entries");
			expect(source).not.toContain("Object.fromEntries");
		}
	});

	test("server entry stays a shallow facade over deeper server Modules", async () => {
		const serverSource = await readFile(
			new URL("./server/index.ts", import.meta.url),
			"utf8"
		);

		expect(serverSource).not.toContain("openai(");
		expect(serverSource).not.toContain("tool({");
		expect(serverSource).not.toContain("new ToolLoopAgent");
		expect(serverSource).not.toContain("providerOptions");
	});

	test("client keeps tool output emission local to one helper", async () => {
		const clientSource = await readFile(
			new URL("./client.ts", import.meta.url),
			"utf8"
		);
		const outputEmissionCount =
			clientSource.match(/await addToolOutput/g)?.length;

		expect(outputEmissionCount).toBe(3);
	});

	test("CLI message consumers do not import the server entry", async () => {
		const cliSources = await Promise.all([
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/ui/components/chat-message.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/ui/components/chat-shell.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/ui/messages/bot-message.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/hooks/use-chat.ts",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/ui/views/chat-view.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/modules/conversations/ui/messages/index.ts",
					import.meta.url
				),
				"utf8"
			),
		]);

		for (const source of cliSources) {
			expect(source).not.toContain('from "@wincode/ai/server"');
		}
	});

	test("CLI tool-call handler does not await chat tool output", async () => {
		const chatScreenSource = await readFile(
			new URL(
				"../../../apps/cli/src/modules/conversations/hooks/use-chat.ts",
				import.meta.url
			),
			"utf8"
		);

		expect(chatScreenSource).not.toContain("await handleCodingAgentToolCall");
		expect(chatScreenSource).not.toContain("await addToolOutput");
	});
});
