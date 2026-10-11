import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearModelPricingCache,
	readModelPricingCache,
	writeModelPricingCache,
} from "@/modules/model-pricing/model-pricing-cache";

let tempDir: string;
let cachePath: string;
let now: number;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-pricing-"));
	cachePath = path.join(tempDir, "model-pricing.json");
	now = 1_700_000_000_000;
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

const TABLE = {
	"openai/gpt-5.6-luna": {
		limits: { context: 400_000 },
		cost: { input: 0.25, output: 2 },
	},
};

describe("model pricing cache", () => {
	test("round-trips a fresh cache within TTL", () => {
		writeModelPricingCache(TABLE, now, cachePath);
		const read = readModelPricingCache(now, 24, cachePath);
		expect(read).not.toBeNull();
		expect(read?.table).toEqual(TABLE);
		expect(read?.fetchedAt).toBe(now);
		expect(read?.stale).toBe(false);
	});

	test("marks the cache stale after the TTL has elapsed, but still returns it", () => {
		writeModelPricingCache(TABLE, now, cachePath);
		const read = readModelPricingCache(
			now + 25 * 60 * 60 * 1000,
			24,
			cachePath
		);
		expect(read).not.toBeNull();
		expect(read?.stale).toBe(true);
		expect(read?.table).toEqual(TABLE);
	});

	test("rejects a cache entry whose cost values are not numbers", () => {
		fs.writeFileSync(
			cachePath,
			JSON.stringify({
				fetchedAt: now,
				table: {
					"openai/gpt-5.6-luna": {
						limits: { context: 400_000 },
						cost: { input: "not-a-number", output: 2 },
					},
				},
				version: 1,
			})
		);
		expect(readModelPricingCache(now, 24, cachePath)).toBeNull();
		expect(fs.existsSync(cachePath)).toBe(false);
	});

	test("returns null when the file is missing", () => {
		expect(readModelPricingCache(now, 24, cachePath)).toBeNull();
	});

	test("returns null and deletes the file for malformed JSON", () => {
		fs.writeFileSync(cachePath, "{ not json");
		expect(readModelPricingCache(now, 24, cachePath)).toBeNull();
		expect(fs.existsSync(cachePath)).toBe(false);
	});

	test("returns null for a wrong cache version", () => {
		fs.writeFileSync(
			cachePath,
			JSON.stringify({ fetchedAt: now, table: {}, version: 999 })
		);
		expect(readModelPricingCache(now, 24, cachePath)).toBeNull();
	});

	test("clearModelPricingCache removes the file", () => {
		writeModelPricingCache(TABLE, now, cachePath);
		clearModelPricingCache(cachePath);
		expect(fs.existsSync(cachePath)).toBe(false);
	});

	test("clearModelPricingCache leaves an unrelated file untouched when the cache is missing", () => {
		const unrelatedPath = path.join(tempDir, "unrelated.json");
		fs.writeFileSync(unrelatedPath, "keep");

		clearModelPricingCache(cachePath);

		expect(fs.existsSync(cachePath)).toBe(false);
		expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("keep");
	});
});
