import { describe, expect, test } from "bun:test";
import { MAX_MCP_RESULT_BYTES, normalizeMcpResult } from "./result";

describe("MCP result normalization", () => {
	test("keeps safe text/structured values and metadata only", () => {
		const result = normalizeMcpResult({
			isError: true,
			content: [
				{ type: "text", text: "ok" },
				{ type: "image", data: "base64-secret", mimeType: "image/png" },
				{ type: "resource_link", uri: "https://x" },
			],
			structuredContent: { n: 1 },
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("base64-secret");
		expect(result.structuredContent).toEqual({ n: 1 });
	});
	test("truncates UTF-8 output within bound", () => {
		const result = normalizeMcpResult({
			content: [{ type: "text", text: "😀".repeat(100_000) }],
		});
		expect(result.truncated).toBe(true);
		expect(
			new TextEncoder().encode(JSON.stringify(result)).byteLength
		).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
	});
});
