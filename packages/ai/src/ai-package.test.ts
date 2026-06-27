import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
	codingModeNames,
	codingModes,
	codingToolDefinitions,
	codingToolSchemas,
	defaultChatModel,
	defaultMode,
	expandFileMentionPartsForModel,
	findSupportedChatModel,
	getNextCodingModeName,
	getSystemInstructions,
	parseMode,
	type ReadInput,
	type ReadOutput,
	supportedChatModelIds,
	supportedChatModels,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
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
				model: "gemini-3.5-flash",
			})
		).toMatchObject({
			metadata: {
				mode: "plan",
				model: "gemini-3.5-flash",
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

	test("defines supported chat models by provider", () => {
		expect(defaultChatModel.value).toBe("gpt-5.4-mini");
		expect(supportedChatModelIds).toEqual([
			"claude-opus-4.8",
			"claude-sonnet-4.6",
			"claude-haiku-4.5",
			"gemini-3.5-flash",
			"gemini-3.1-pro-preview",
			"gemini-2.5-pro",
			"gpt-5.5",
			"gpt-5.5-pro",
			"gpt-5.4-mini",
		]);
		expect(new Set(supportedChatModels.map((model) => model.provider))).toEqual(
			new Set(["anthropic", "google", "openai"])
		);
		expect(findSupportedChatModel("gemini-3.5-flash")).toMatchObject({
			id: "gemini-3.5-flash",
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
					"../../../apps/cli/src/components/chat/chat-message.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/components/chat/chat-shell.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/components/chat/messages/bot-message.tsx",
					import.meta.url
				),
				"utf8"
			),
			readFile(
				new URL("../../../apps/cli/src/hooks/use-chat.ts", import.meta.url),
				"utf8"
			),
			readFile(
				new URL("../../../apps/cli/src/screens/chat.tsx", import.meta.url),
				"utf8"
			),
			readFile(
				new URL(
					"../../../apps/cli/src/routes/sessions/$id/route.tsx",
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
			new URL("../../../apps/cli/src/screens/chat.tsx", import.meta.url),
			"utf8"
		);

		expect(chatScreenSource).not.toContain("await handleCodingAgentToolCall");
	});
});
