import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";
import type { ModelPricingTable } from "./model-pricing";
import { modelPricingTableSchema } from "./model-pricing";

const CACHE_FILE_NAME = "model-pricing.json";
const CACHE_VERSION = 1;

const cacheFileSchema = z.object({
	fetchedAt: z.number().int().nonnegative(),
	table: modelPricingTableSchema,
	version: z.literal(CACHE_VERSION),
});

const HOUR_MS = 60 * 60 * 1000;

export const resolveModelPricingCachePath = (): string =>
	join(resolveUserDataDir(), CACHE_FILE_NAME);

type CacheFile = { fetchedAt: number; table: ModelPricingTable };

/**
 * A cache entry that parsed successfully. `stale` tells the caller whether
 * the TTL has elapsed — the table is still returned so the UI can show it
 * immediately while a background refresh runs (stale-while-revalidate),
 * instead of falling all the way back to the bundled snapshot.
 */
export type ModelPricingCacheEntry = CacheFile & { stale: boolean };

const parseCacheFile = (raw: string): CacheFile | null => {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = cacheFileSchema.safeParse(parsedJson);
	if (!result.success) {
		return null;
	}
	return { fetchedAt: result.data.fetchedAt, table: result.data.table };
};

const readCacheFileFromPath = (path: string): CacheFile | null => {
	if (!existsSync(path)) {
		return null;
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const parsed = parseCacheFile(raw);
	if (!parsed) {
		try {
			unlinkSync(path);
		} catch {
			// best effort
		}
		return null;
	}
	return parsed;
};

const writeCacheToPath = (
	path: string,
	table: ModelPricingTable,
	now: number
): void => {
	mkdirSync(dirname(path), { recursive: true });
	const payload = JSON.stringify({
		fetchedAt: now,
		table,
		version: CACHE_VERSION,
	});
	writeFileSync(path, payload);
};

export const readModelPricingCache = (
	now: number,
	ttlHours: number,
	cachePath: string = resolveModelPricingCachePath()
): ModelPricingCacheEntry | null => {
	const parsed = readCacheFileFromPath(cachePath);
	if (!parsed) {
		return null;
	}
	const stale = now - parsed.fetchedAt > ttlHours * HOUR_MS;
	return { ...parsed, stale };
};

export const writeModelPricingCache = (
	table: ModelPricingTable,
	now: number,
	cachePath: string = resolveModelPricingCachePath()
): void => writeCacheToPath(cachePath, table, now);

export const clearModelPricingCache = (
	cachePath: string = resolveModelPricingCachePath()
): void => {
	if (!existsSync(cachePath)) {
		return;
	}
	try {
		unlinkSync(cachePath);
	} catch {
		// best effort
	}
};
