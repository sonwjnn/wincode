import type { ModelPricingTable } from "./model-pricing";
import { buildModelPricingTable } from "./models-dev-response";

const DEFAULT_TIMEOUT_MS = 5000;
/**
 * If a "successful" response covers less than this fraction of the ids we
 * asked for, treat it as a failure instead of caching a sparse table. This
 * catches a models.dev shape change or a captive-portal JSON response that
 * would otherwise parse to `{}` (or near-empty) and get written to the
 * on-disk cache, hiding the footer for every model until the TTL expires.
 */
const MIN_COVERAGE_RATIO = 0.5;

/**
 * Fetches the live models.dev pricebook. Returns `null` on any failure
 * (non-200, wrong content type, parse error, network error, timeout, or a
 * parsed table that covers too few of the requested ids to be trustworthy).
 * Caller is expected to fall back to the on-disk cache and the snapshot.
 */
export const fetchModelPricingTable = async (
	url: string,
	ids: ReadonlySet<string>,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ModelPricingTable | null> => {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("json")) {
		return null;
	}
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		return null;
	}
	const table = buildModelPricingTable(raw, ids);
	if (
		ids.size > 0 &&
		Object.keys(table).length < ids.size * MIN_COVERAGE_RATIO
	) {
		return null;
	}
	return table;
};
