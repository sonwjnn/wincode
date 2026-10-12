import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const bunConsumer = `
import assert from "node:assert/strict";
import { createProviderCollection } from "@wincode/ai/sdk";
import { createGoogleProvider } from "@wincode/ai/sdk/providers/google";
import { createOpenCodeGoProvider } from "@wincode/ai/sdk/providers/opencode-go";

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
await google.close();
process.stdout.write("Bun public SDK consumer passed");
`;

describe("Bun external @wincode/ai consumer", () => {
	test("registers Google and OpenCode Go through public subpaths", async () => {
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
