import { afterEach, describe, expect, mock, test } from "bun:test";
// Keep the process-global Bun module mock complete: test files execute in one
// process and may import unrelated AI SDK exports while this mock is active.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realAi from "ai";

const createAgentUIStreamResponseMock = mock(
	(input: {
		agent: {
			onFinish?: (event: unknown) => Promise<void>;
			onStepFinish?: (event: unknown) => Promise<void>;
		};
		abortSignal?: AbortSignal;
		options?: Record<string, unknown>;
	}) => {
		const stream = new ReadableStream<Uint8Array>({
			start: async (controller) => {
				if (input.abortSignal?.aborted) {
					controller.error(new Error("aborted"));
					return;
				}

				await input.agent.onStepFinish?.({ stepNumber: 0 });
				await input.agent.onFinish?.({ steps: [{ stepNumber: 0 }] });
				controller.enqueue(new TextEncoder().encode("ok"));
				controller.close();
			},
		});

		return new Response(stream, { status: 200 });
	}
);

class MockToolLoopAgent {
	constructor(config: Record<string, unknown>) {
		Object.assign(this, config);
	}
}

const loadSubject = async () => {
	await mock.module("ai", () => ({
		...realAi,
		ToolLoopAgent: MockToolLoopAgent,
		createAgentUIStreamResponse: createAgentUIStreamResponseMock,
		createIdGenerator: () => () => "msg-1",
		stepCountIs: () => () => true,
	}));

	return import(`./stream?test=${crypto.randomUUID()}`);
};

afterEach(() => {
	mock.restore();
	mock.clearAllMocks();
});

describe("createCodingAgentStreamResponse", () => {
	test("forwards default and supplied MCP manifests to agent options", async () => {
		const { createCodingAgentStreamResponse } = await loadSubject();
		const base = {
			model: {} as never,
			modelId: "gpt-5.4-mini" as const,
			uiMessages: [{ id: "1", parts: [], role: "user" } as never],
		};

		await createCodingAgentStreamResponse(base);
		await createCodingAgentStreamResponse({
			...base,
			mcpTools: [{ name: "search", description: "", inputSchema: {} }],
		});

		expect(createAgentUIStreamResponseMock.mock.calls[0]?.[0].options).toEqual({
			model: "gpt-5.4-mini",
			mcpTools: [],
		});
		expect(createAgentUIStreamResponseMock.mock.calls[1]?.[0].options).toEqual({
			model: "gpt-5.4-mini",
			mcpTools: [{ name: "search", description: "", inputSchema: {} }],
		});
	});

	test("fires step and end once when stream consumed", async () => {
		const onStepEnd = mock(async () => undefined);
		const onEnd = mock(async () => undefined);
		const { createCodingAgentStreamResponse } = await loadSubject();

		const response = (await createCodingAgentStreamResponse({
			model: {} as never,
			modelId: "gpt-5.4-mini",
			onEnd,
			onStepEnd,
			uiMessages: [{ id: "1", parts: [], role: "user" } as never],
		})) as Response;

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("missing reader");
		}

		for (;;) {
			const { done } = await reader.read();
			if (done) {
				break;
			}
		}

		await reader.cancel();

		expect(createAgentUIStreamResponseMock).toHaveBeenCalledTimes(1);
		expect(onStepEnd).toHaveBeenCalledTimes(1);
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	test("skips callbacks on abort before consume", async () => {
		const onStepEnd = mock(async () => undefined);
		const onEnd = mock(async () => undefined);
		const controller = new AbortController();
		controller.abort();
		const { createCodingAgentStreamResponse } = await loadSubject();

		const response = (await createCodingAgentStreamResponse({
			abortSignal: controller.signal,
			model: {} as never,
			modelId: "gpt-5.4-mini",
			onEnd,
			onStepEnd,
			uiMessages: [{ id: "1", parts: [], role: "user" } as never],
		})) as Response;

		const reader = response.body?.getReader();
		await expect(reader?.read()).rejects.toThrow("aborted");
		expect(onStepEnd).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});
});
