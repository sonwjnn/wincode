import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const nodeConsumer = `
import assert from "node:assert/strict";
import { createProviderCollection } from "@wincode/ai/sdk";
import { createGoogleProvider } from "@wincode/ai/sdk/providers/google";
import { createOpenCodeGoProvider } from "@wincode/ai/sdk/providers/opencode-go";

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
    assert.equal(String(url), "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer node-go-key");
    return sse([
      { choices: [{ delta: { content: "Node OpenCode" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
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
assert.equal(cache.created, 1);
await google.close();
assert.equal(cache.deleted, 1);
process.stdout.write("Node public SDK consumer passed");
`;

describe("Node external @wincode/ai consumer", () => {
	test("registers Google and OpenCode Go through public subpaths without Bun runtime APIs", async () => {
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
