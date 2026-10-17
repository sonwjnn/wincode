import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const bunConsumer = `
import assert from "node:assert/strict";
import { createProviderCollection, ProviderError } from "@wincode/ai";
import { createGoogleProvider } from "@wincode/ai";
import { createOpenCodeGoProvider } from "@wincode/ai";

const separator = String.fromCharCode(10);
const sse = (events) => new Response(events.map((event) => "data: " + JSON.stringify(event) + separator + separator).join(""), { headers: { "content-type": "text/event-stream" } });
const sdk = createProviderCollection();
const google = createGoogleProvider({
  fetch: async (_url, init) => {
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "bun-google-key");
    return sse([{ candidates: [{ content: { parts: [{ text: "Bun Google" }] } }] }, { candidates: [{ finishReason: "STOP" }] }]);
  },
});
const opencode = createOpenCodeGoProvider({
  fetch: async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer bun-go-key");
    return sse([{ choices: [{ delta: { content: "Bun OpenCode" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
  },
});
sdk.register(google);
sdk.register(opencode);
await sdk.setCredential("google", { kind: "api-key", apiKey: "bun-google-key" });
await sdk.setCredential("opencode-go", { kind: "api-key", apiKey: "bun-go-key" });
for (const [providerId, modelId, expected] of [["google", "gemini-3.8-flash", "Bun Google"], ["opencode-go", "grok-4.6", "Bun OpenCode"]]) {
  const events = [];
  for await (const event of sdk.chat({ messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], providerId, modelId })) events.push(event);
  assert(events.some((event) => event.type === "text-delta" && event.delta === expected));
}
const controlRequests = [];
sdk.register({
  id: "bun-control-provider",
  models: [{ modelId: "control-model", protocolId: "fake-wire", providerId: "bun-control-provider" }],
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
    { role: "assistant", continuation: { cursor: "previous" }, content: [{ type: "tool-call", toolCallId: "bun-call", toolName: "weather", input: { city: "Paris" } }] },
    { role: "tool", content: [{ type: "tool-failure", toolCallId: "bun-call", toolName: "weather", errorText: "Weather lookup failed.", failure: { kind: "timeout" } }] },
  ],
  modelId: "control-model",
  providerId: "bun-control-provider",
  cacheRetention: "long",
  reasoningEffort: "high",
  maxOutputTokens: 384,
  promptCacheKey: "stable-bun-cache-key",
  cacheWarming: true,
})) controlEvents.push(event);
assert.equal(controlRequests[0].reasoningEffort, "high");
assert.equal(controlRequests[0].maxOutputTokens, 384);
assert.equal(controlRequests[0].promptCacheKey, "stable-bun-cache-key");
assert.equal(controlRequests[0].cacheWarming, true);
assert.equal(controlRequests[0].cacheRetention, "long");
assert.equal(controlRequests[0].messages[0].continuation.cursor, "previous");
assert.deepEqual(controlRequests[0].messages[1].content[0], { type: "tool-failure", toolCallId: "bun-call", toolName: "weather", errorText: "Weather lookup failed.", failure: { kind: "timeout" } });
assert(controlEvents.some((event) => event.type === "usage" && event.usage.cacheReadTokens === 3));
assert.equal(controlEvents.at(-1).outcome.status, "success");
assert.equal(controlEvents.at(-1).outcome.continuation.cursor, "next");
sdk.register({
  id: "bun-failure-provider",
  models: [{ modelId: "failure-model", protocolId: "fake-wire", providerId: "bun-failure-provider" }],
  resolveAuthorization: async () => ({ authorization: "fake" }),
  async *streamChat() { throw new ProviderError("authentication", "fake credentials rejected"); },
});
const failureEvents = [];
for await (const event of sdk.chat({ messages: [], modelId: "failure-model", providerId: "bun-failure-provider" })) failureEvents.push(event);
assert.deepEqual(failureEvents.at(-1), { type: "terminal", outcome: { status: "failure", failure: { code: "authentication", message: "fake credentials rejected", providerId: "bun-failure-provider" } } });
const abortController = new AbortController();
abortController.abort(new DOMException("Bun request cancelled", "AbortError"));
const abortEvents = [];
for await (const event of sdk.chat({ messages: [], modelId: "control-model", providerId: "bun-control-provider", signal: abortController.signal })) abortEvents.push(event);
assert.deepEqual(abortEvents, [{ type: "terminal", outcome: { status: "aborted", reason: "Bun request cancelled" } }]);
await google.close();
process.stdout.write("Bun public SDK consumer passed");
`;

describe("Bun external @wincode/ai consumer", () => {
	test("Bun consumers preserve chat controls and terminal outcomes through the public SDK", async () => {
		const consumerDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-ai-bun-consumer-")
		);
		try {
			const scopeDir = path.join(consumerDir, "node_modules", "@wincode");
			await fs.mkdir(scopeDir, { recursive: true });
			await fs.symlink(
				path.resolve(import.meta.dir, ".."),
				path.join(scopeDir, "ai"),
				"dir"
			);
			const child = Bun.spawn(["bun", "-e", bunConsumer], {
				cwd: consumerDir,
				stderr: "pipe",
				stdout: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, `${stdout}${stderr}`).toBe(0);
			expect(stdout).toContain("Bun public SDK consumer passed");
		} finally {
			await fs.rm(consumerDir, { force: true, recursive: true });
		}
	});
});
