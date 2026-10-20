import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const nodeConsumer = `
import assert from "node:assert/strict";
import { createProviderCollection, ProviderError } from "@wincode/ai";
import { createGoogleProvider } from "@wincode/ai";
import { createOpenCodeGoProvider } from "@wincode/ai";

const separator = String.fromCharCode(10);
const sse = (events) => new Response(events.map((event) => "data: " + JSON.stringify(event) + separator + separator).join(""), { headers: { "content-type": "text/event-stream" } });
const cache = { created: 0, deleted: 0 };
const google = createGoogleProvider({
  createCacheClient: () => ({
    create: async () => { cache.created += 1; return { name: "cachedContents/node" }; },
    delete: async () => { cache.deleted += 1; return {}; },
  }),
  fetch: async (url, init) => {
    assert.match(String(url), /gemini-3[.]8-flash:streamGenerateContent/u);
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "node-google-key");
    return sse([
      { candidates: [{ content: { parts: [{ text: "Node Google" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } },
    ]);
  },
});
const opencode = createOpenCodeGoProvider({
  fetch: async (url, init) => {
    assert.equal(String(url), "https://opencode.ai/zen/go/v1/responses");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer node-go-key");
    return sse([
      { type: "response.output_text.delta", delta: "Node OpenCode" },
      { type: "response.completed", response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
  },
});
const sdk = createProviderCollection();
sdk.register(google);
sdk.register(opencode);
await sdk.setCredential("google", { kind: "api-key", apiKey: "node-google-key" });
await sdk.setCredential("opencode-go", { kind: "api-key", apiKey: "node-go-key" });
const collect = async (providerId, modelId, cacheRetention) => {
  const events = [];
  for await (const event of sdk.chat({
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    modelId,
    providerId,
    ...(cacheRetention ? { cacheRetention } : {}),
    ...(providerId === "google" ? { system: "Node cache prefix" } : {}),
  })) events.push(event);
  return events;
};
const googleEvents = await collect("google", "gemini-3.8-flash", "short");
const goEvents = await collect("opencode-go", "grok-4.6");
assert(googleEvents.some((event) => event.type === "text-delta" && event.delta === "Node Google"));
assert(goEvents.some((event) => event.type === "text-delta" && event.delta === "Node OpenCode"));
const controlRequests = [];
sdk.register({
  id: "node-control-provider",
  models: [{ modelId: "control-model", protocolId: "fake-wire", providerId: "node-control-provider" }],
  resolveAuthorization: async () => ({ authorization: "fake" }),
  async *streamChat(request) {
    controlRequests.push(request);
    yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 } };
    yield { type: "finish", continuation: { cursor: "next" } };
  },
});
const controlEvents = [];
for await (const event of sdk.chat({
  messages: [
    { role: "assistant", continuation: { cursor: "previous" }, content: [{ type: "tool-call", toolCallId: "node-call", toolName: "weather", input: { city: "Paris" } }] },
    { role: "tool", content: [{ type: "tool-failure", toolCallId: "node-call", toolName: "weather", errorText: "Weather lookup failed.", failure: { kind: "timeout" } }] },
  ],
  modelId: "control-model",
  providerId: "node-control-provider",
  cacheRetention: "long",
  reasoningEffort: "high",
  maxOutputTokens: 384,
  promptCacheKey: "stable-node-cache-key",
  cacheWarming: true,
})) controlEvents.push(event);
assert.equal(controlRequests[0].reasoningEffort, "high");
assert.equal(controlRequests[0].maxOutputTokens, 384);
assert.equal(controlRequests[0].promptCacheKey, "stable-node-cache-key");
assert.equal(controlRequests[0].cacheWarming, true);
assert.equal(controlRequests[0].cacheRetention, "long");
assert.equal(controlRequests[0].messages[0].continuation.cursor, "previous");
assert.deepEqual(controlRequests[0].messages[1].content[0], { type: "tool-failure", toolCallId: "node-call", toolName: "weather", errorText: "Weather lookup failed.", failure: { kind: "timeout" } });
assert(controlEvents.some((event) => event.type === "usage" && event.usage.cacheReadTokens === 3));
assert.equal(controlEvents.at(-1).outcome.status, "success");
assert.equal(controlEvents.at(-1).outcome.continuation.cursor, "next");
const defaultControlEvents = [];
for await (const event of sdk.chat({
  messages: [],
  modelId: "control-model",
  providerId: "node-control-provider",
})) defaultControlEvents.push(event);
assert.equal(defaultControlEvents.at(-1).outcome.status, "success");
assert.deepEqual(Object.keys(controlRequests[1]), ["messages"]);
sdk.register({
  id: "node-failure-provider",
  models: [{ modelId: "failure-model", protocolId: "fake-wire", providerId: "node-failure-provider" }],
  resolveAuthorization: async () => ({ authorization: "fake" }),
  async *streamChat() { throw new ProviderError("transport", "fake transport failed"); },
});
const failureEvents = [];
for await (const event of sdk.chat({ messages: [], modelId: "failure-model", providerId: "node-failure-provider" })) failureEvents.push(event);
assert.deepEqual(failureEvents.at(-1), { type: "terminal", outcome: { status: "failure", failure: { code: "transport", message: "fake transport failed", providerId: "node-failure-provider" } } });
const abortController = new AbortController();
abortController.abort(new DOMException("Node request cancelled", "AbortError"));
const abortEvents = [];
for await (const event of sdk.chat({ messages: [], modelId: "control-model", providerId: "node-control-provider", signal: abortController.signal })) abortEvents.push(event);
assert.deepEqual(abortEvents, [{ type: "terminal", outcome: { status: "aborted", reason: "Node request cancelled" } }]);
assert.equal(cache.created, 1);
await google.close();
assert.equal(cache.deleted, 1);
process.stdout.write("Node public SDK consumer passed");
`;

describe("Node external @wincode/ai consumer", () => {
	test("Node consumers import the public SDK", async () => {
		await $`bun run build`
			.cwd(path.resolve(import.meta.dir, "../../utils"))
			.quiet();
		const consumerDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-ai-node-consumer-")
		);
		try {
			const scopeDir = path.join(consumerDir, "node_modules", "@wincode");
			await fs.mkdir(scopeDir, { recursive: true });
			await fs.symlink(
				path.resolve(import.meta.dir, ".."),
				path.join(scopeDir, "ai"),
				"dir"
			);
			const child = Bun.spawn(
				["node", "--input-type=module", "-e", nodeConsumer],
				{
					cwd: consumerDir,
					stderr: "pipe",
					stdout: "pipe",
				}
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, `${stdout}${stderr}`).toBe(0);
			expect(stdout).toContain("Node public SDK consumer passed");
		} finally {
			await fs.rm(consumerDir, { force: true, recursive: true });
		}
	});
});
