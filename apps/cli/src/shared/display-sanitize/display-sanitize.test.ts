import { describe, expect, test } from "bun:test";
import {
	boundCommandHeader,
	boundPreview,
	computeContentWidth,
	formatAgent,
	formatMcpToolName,
	formatModel,
	formatResponseTime,
	formatSkillHash,
	formatToolName,
	formatUnknown,
	isSensitiveKey,
	measureCellWidth,
	REDACTED,
	redactSensitiveText,
	resolveOverflowIndicator,
	sanitizeArgumentTree,
	sanitizeShellOutput,
	sanitizeText,
	stripAnsi,
	stripControlCharacters,
	truncateToWidth,
	truncateWithOverflow,
	wrapToWidth,
} from "@/shared/display-sanitize";

describe("redactSensitiveText", () => {
	test("redacts secret-looking key=value tokens", () => {
		expect(redactSensitiveText("Authorization: Bearer hidden-token")).toBe(
			REDACTED
		);
		expect(redactSensitiveText("apiKey = secret-value")).toBe(REDACTED);
		expect(redactSensitiveText("token=super-secret-token")).toBe(REDACTED);
	});

	test("preserves the key name in keepKey mode", () => {
		expect(
			redactSensitiveText("token=super-secret-token", { keepKey: true })
		).toBe(`token=${REDACTED}`);
		expect(
			redactSensitiveText("with Bearer super-secret-token", { keepKey: true })
		).toBe(`with ${REDACTED}`);
	});

	test("redacts URLs when requested", () => {
		expect(
			redactSensitiveText("connect failed at https://secret-host.example/mcp", {
				redactUrls: true,
			})
		).toBe("connect failed at [redacted]");
	});

	test("substitutes exact secrets before pattern redaction", () => {
		expect(
			redactSensitiveText("boom env-super-secret", {
				secrets: ["env-super-secret"],
			})
		).toBe("boom [redacted]");
	});
});

describe("sanitizeText", () => {
	test("replaces control characters with spaces", () => {
		expect(sanitizeText("a\nb")).toBe("a b");
		expect(stripControlCharacters("a\u0000b")).toBe("a b");
	});

	test("bounds the stripped result to maxChars", () => {
		expect(stripControlCharacters("a\u0000bcd", 3)).toBe("a b");
	});

	test("redacts after stripping controls", () => {
		expect(sanitizeText("failed\nAuthorization: Bearer hidden-error")).toBe(
			"failed [redacted]"
		);
	});

	test("bounds the result to maxChars", () => {
		expect(sanitizeText("y".repeat(700), { maxChars: 512 })).toHaveLength(512);
	});
});

describe("isSensitiveKey", () => {
	test("detects secret key names after stripping punctuation", () => {
		expect(isSensitiveKey("apiKey")).toBe(true);
		expect(isSensitiveKey("a\nuth")).toBe(true);
		expect(isSensitiveKey("query")).toBe(false);
	});
});

describe("sanitizeArgumentTree", () => {
	test("redacts sensitive keys and secret-looking values", () => {
		const sanitized = sanitizeArgumentTree({
			apiKey: "secret-value",
			headers: "Authorization: Bearer hidden-bearer",
			query: "safe query",
		}) as Record<string, unknown>;

		expect(sanitized.apiKey).toBe(REDACTED);
		expect(sanitized.headers).toContain(REDACTED);
		expect(sanitized.query).toBe("safe query");
	});

	test("replaces cycles with [circular]", () => {
		const input: Record<string, unknown> = { self: null };
		input.self = input;
		expect(sanitizeArgumentTree(input)).toEqual({ self: "[circular]" });
	});

	test("bounds nesting depth with the default marker", () => {
		const sanitized = sanitizeArgumentTree({
			nested: { child: { grandchild: { value: "hidden" } } },
		}) as { nested: { child: unknown } };
		expect(sanitized.nested.child).toBe("[…]");
	});

	test("bounds entries per object", () => {
		const sanitized = sanitizeArgumentTree(
			Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, i]))
		);
		expect(Object.keys(sanitized as Record<string, unknown>)).toHaveLength(12);
	});

	test("redacts secret-looking values inside keys with redactValuesInKeys", () => {
		const sanitized = sanitizeArgumentTree(
			{ "token=abc": 1 },
			{
				redactValuesInKeys: true,
			}
		) as Record<string, unknown>;
		expect(Object.keys(sanitized)).toEqual(["[redacted]"]);
	});

	test("keeps keys verbatim without redactValuesInKeys", () => {
		const sanitized = sanitizeArgumentTree({ "token=abc": 1 }) as Record<
			string,
			unknown
		>;
		expect(Object.keys(sanitized)).toEqual(["token=abc"]);
	});

	test("approval options: deeper traversal and plain ellipsis marker", () => {
		const sanitized = sanitizeArgumentTree(
			{ a: { b: { c: { d: { value: "hidden" } } } } },
			{ depthOverflow: "…", maxDepth: 4, maxEntries: 24 }
		) as { a: { b: { c: { d: unknown } } } };
		expect(sanitized.a.b.c.d).toBe("…");
	});
});

describe("stripAnsi and sanitizeShellOutput", () => {
	test("strips CSI color sequences", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
	});

	test("strips OSC title sequences", () => {
		expect(stripAnsi("\u001b]0;title\u0007x")).toBe("x");
	});

	test("sanitizeShellOutput collapses CRLF and drops bare carriage returns", () => {
		expect(sanitizeShellOutput("a\r\nb\rc")).toBe("a\nbc");
	});

	test("sanitizeShellOutput drops the trailing newline", () => {
		expect(sanitizeShellOutput("a\n")).toBe("a");
	});

	test("sanitizes shell output end to end", () => {
		expect(
			sanitizeShellOutput("\u001b[31mboom\nAuthorization: Bearer hidden-token")
		).toBe("boom\n[redacted]");
	});

	test("keeps newlines and tabs but removes other control characters", () => {
		expect(sanitizeShellOutput("a\nb\tc\u0000d")).toBe("a\nb\tcd");
	});

	test("bounds to maxChars", () => {
		const output = sanitizeShellOutput("x".repeat(4096), 100);
		expect(output).toHaveLength(100);
	});
});

describe("measureCellWidth, wrapToWidth, truncateToWidth", () => {
	test("tabs occupy one cell and wide characters two", () => {
		expect(measureCellWidth("\t")).toBe(1);
		expect(measureCellWidth("界")).toBe(2);
	});

	test("wraps lines by cell width without splitting wide characters", () => {
		expect(wrapToWidth("a界b", 3)).toEqual(["a界", "b"]);
		expect(wrapToWidth("", 10)).toEqual([""]);
	});

	test("truncates without splitting a wide character", () => {
		expect(truncateToWidth("界abc", 2)).toBe("界");
		expect(truncateToWidth("abc", 2)).toBe("ab");
	});

	test("computeContentWidth subtracts padding and border", () => {
		expect(computeContentWidth(100)).toBe(95);
	});
});

describe("boundPreview and resolveOverflowIndicator", () => {
	const WIDE = 160;

	test("bounds output to six visual rows and reports hidden logical lines", () => {
		const preview = boundPreview("1\n2\n3\n4\n5\n6\n7", WIDE);
		expect(preview).toEqual({
			hasOverflow: true,
			hiddenLogicalLines: 1,
			text: "1\n2\n3\n4\n5\n6",
		});
		expect(resolveOverflowIndicator(preview)).toBe("… 1 more lines");
	});

	test("reports wrapping-only overflow as more output", () => {
		const preview = boundPreview("one very long line that wraps many times", 5);
		expect(preview.hasOverflow).toBe(true);
		expect(preview.hiddenLogicalLines).toBe(0);
		expect(resolveOverflowIndicator(preview)).toBe("… more output");
	});

	test("returns no indicator when everything fits", () => {
		expect(resolveOverflowIndicator(boundPreview("short", WIDE))).toBeNull();
	});

	test("bounds the command header to two rows with an ellipsis", () => {
		const header = boundCommandHeader("run --with-a-very-long-flag-list", 10);
		expect(header.split("\n")).toHaveLength(2);
		expect(header.endsWith("…")).toBe(true);
	});
});

describe("display formatters", () => {
	test("formatUnknown renders primitives and JSON", () => {
		expect(formatUnknown(undefined)).toBe("");
		expect(formatUnknown(null)).toBe("");
		expect(formatUnknown("text")).toBe("text");
		expect(formatUnknown({ a: 1 })).toBe('{"a":1}');
	});

	test("formatResponseTime", () => {
		expect(formatResponseTime(431)).toBe("431ms");
		expect(formatResponseTime(4300)).toBe("4.3s");
		expect(formatResponseTime(159_000)).toBe("2m 39s");
	});

	test("formatToolName splits camel case and capitalizes", () => {
		expect(formatToolName("legacy")).toBe("Legacy");
		expect(formatToolName("myTool")).toBe("My Tool");
	});

	test("formatMcpToolName strips prefixes and hashes", () => {
		expect(formatMcpToolName("mcp_context7_query-docs_3f6b8a11")).toBe(
			"context7_query-docs"
		);
		expect(formatMcpToolName("mcp_search_docs")).toBe("search_docs");
		expect(formatMcpToolName("mcp_server_abc12345")).toBe("server_abc12345");
	});

	test("formatAgent capitalizes the first character", () => {
		expect(formatAgent("claude")).toBe("Claude");
	});

	test("formatSkillHash shortens long hashes", () => {
		expect(formatSkillHash("abcdef1234567890")).toBe("abcdef123456…");
		expect(formatSkillHash("hash-1")).toBe("hash-1");
	});

	test("truncateWithOverflow bounds with an ellipsis", () => {
		expect(truncateWithOverflow("12345", 3)).toBe("123…");
		expect(truncateWithOverflow("123", 3)).toBe("123");
	});

	test("formatModel normalizes selections", () => {
		expect(formatModel("gpt-4o")).toEqual({
			label: "gpt-4o",
			providerId: undefined,
		});
	});
});
