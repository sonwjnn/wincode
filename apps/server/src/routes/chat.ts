import { devToolsMiddleware } from "@ai-sdk/devtools";
import { openai } from "@ai-sdk/openai";
import { zValidator } from "@hono/zod-validator";
import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	tool,
	validateUIMessages,
	wrapLanguageModel,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";

const chatRequestSchema = z.object({
	messages: z.array(z.unknown()).min(1),
	sendReasoning: z.boolean().optional(),
});

const tools = {
	get_weather: tool({
		description: "Get the current weather in a given city",
		inputSchema: z.object({
			city: z.string().describe("The city to get the weather for"),
		}),
		execute: ({ city }) => {
			const conditions = ["sunny", "cloudy", "rainy", "snowy"] as const;
			const condition =
				conditions[Math.floor(Math.random() * conditions.length)];

			return { city, condition };
		},
	}),
};

const createChatStreamResponse = async (
	messages: unknown[],
	sendReasoning = true
) => {
	const validatedMessages = await validateUIMessages({
		messages,
	});
	const model = wrapLanguageModel({
		model: openai("gpt-5.4-mini"),
		middleware: devToolsMiddleware(),
	});
	const result = streamText({
		model,
		messages: await convertToModelMessages(validatedMessages),
		providerOptions: {
			anthropic: {
				thinking: { type: "adaptive" },
			},
			google: {
				thinkingConfig: { includeThoughts: true },
			},
			openai: {
				reasoningSummary: "detailed",
			},
		},
		stopWhen: stepCountIs(5),
		system: "Use get_weather for weather requests.",
		tools,
	});

	return result.toUIMessageStreamResponse({
		originalMessages: validatedMessages,
		sendReasoning,
	});
};

export const chatRoutes = new Hono().post(
	"/",
	zValidator("json", chatRequestSchema),
	(c) => {
		const { messages, sendReasoning } = c.req.valid("json");
		return createChatStreamResponse(messages, sendReasoning);
	}
);
