import { describe, expect, test } from "bun:test";
import { credentialSchemas } from "./contract";

describe("connections contract", () => {
	test("credential schemas stay strict", () => {
		expect(() =>
			credentialSchemas.openai.parse({
				apiKey: "x",
				kind: "api-key",
				extra: true,
			})
		).toThrow();
	});
});
