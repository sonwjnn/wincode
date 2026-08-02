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
	test("bounds a huge resource link URI without scanning into the tail", () => {
		const tail = "resource-link-tail";
		const uri = `${"x".repeat(20 * 1024 * 1024)}${tail}`;
		const result = normalizeMcpResult({
			content: [{ type: "resource_link", uri }],
		});

		const resourceLink = result.content[0];
		expect(resourceLink).toMatchObject({
			type: "resource_link",
			uri: "x".repeat(2048),
		});
		expect(JSON.stringify(resourceLink)).not.toContain(tail);
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
	test("does not return unpaired surrogates when truncating U+1FFFF", () => {
		const result = normalizeMcpResult({
			content: [{ type: "text", text: "\u{1ffff}".repeat(100_000) }],
		});
		const serialized = JSON.stringify(result);
		for (let index = 0; index < serialized.length; index += 1) {
			const codeUnit = serialized.charCodeAt(index);
			if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
				expect(serialized.charCodeAt(index + 1)).toBeGreaterThanOrEqual(
					0xdc_00
				);
				expect(serialized.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdf_ff);
				index += 1;
			} else {
				expect(codeUnit < 0xdc_00 || codeUnit > 0xdf_ff).toBe(true);
			}
		}
	});
	test("preserves embedded resource text beyond metadata bounds", () => {
		const text = "resource text ".repeat(300);
		const result = normalizeMcpResult({
			content: [{ type: "resource", resource: { uri: "file://x", text } }],
		});

		expect(result.truncated).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "resource", text });
	});
	test("truncates huge embedded resource text at the global cap", () => {
		const result = normalizeMcpResult({
			content: [
				{
					type: "resource",
					resource: { uri: "file://x", text: "😀".repeat(100_000) },
				},
			],
		});

		expect(result.truncated).toBe(true);
		expect(
			new TextEncoder().encode(JSON.stringify(result)).byteLength
		).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
		const resource = result.content[0];
		if (
			typeof resource === "object" &&
			resource !== null &&
			"text" in resource
		) {
			expect(
				new TextEncoder().encode(resource.text as string).byteLength % 4
			).toBe(0);
		}
	});
});
