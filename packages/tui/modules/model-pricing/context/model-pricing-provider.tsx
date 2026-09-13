import {
	modelMetadataSnapshotDate,
	supportedChatModelIds,
} from "@wincode/ai/models";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { fetchModelPricingTable } from "../fetch-model-pricing";
import type { ModelPricingSource, ModelPricingTable } from "../model-pricing";
import {
	readModelPricingCache,
	writeModelPricingCache,
} from "../model-pricing-cache";
import { modelPricingEnv } from "../model-pricing-env";

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_URL = "https://models.dev/api.json";
const modelIds = new Set<string>(supportedChatModelIds);
/**
 * The generated Model Catalog metadata is the base, so an empty table is a
 * complete fallback: the fetch only refreshes values, never supplies them.
 */
const NO_OVERRIDES: ModelPricingTable = {};

let fetchPromise: Promise<ModelPricingTable | null> | null = null;

const runFetch = (
	url: string,
	now: number
): Promise<ModelPricingTable | null> => {
	if (!fetchPromise) {
		fetchPromise = fetchModelPricingTable(url, modelIds).then((table) => {
			if (table) {
				try {
					writeModelPricingCache(table, now);
				} catch {
					// best effort
				}
			}
			return table;
		});
	}
	return fetchPromise;
};

export type ModelPricingState = {
	offline: boolean;
	/** The date the build-time snapshot was generated, `YYYY-MM-DD`. */
	snapshotDate: string;
	/** Where `table` came from, so a reader can tell how current it is. */
	source: ModelPricingSource;
	table: ModelPricingTable;
};

const ModelPricingContext = createContext<ModelPricingState | null>(null);

type ModelPricingProviderProps = {
	children: ReactNode;
	/** Override the live table for deterministic composition tests. */
	pricing?: ModelPricingTable;
};

export function ModelPricingProvider({
	children,
	pricing,
}: ModelPricingProviderProps) {
	const offline = modelPricingEnv.WINCODE_MODEL_PRICING_OFFLINE === true;
	const ttlHours =
		modelPricingEnv.WINCODE_MODEL_PRICING_TTL_HOURS ?? DEFAULT_TTL_HOURS;
	const url = modelPricingEnv.WINCODE_MODEL_PRICING_URL ?? DEFAULT_URL;

	const [loadedTable, setLoadedTable] =
		useState<ModelPricingTable>(NO_OVERRIDES);
	const [source, setSource] = useState<ModelPricingSource>("bundled");
	const bootstrappedRef = useRef(false);
	const table = pricing ?? loadedTable;

	useEffect(() => {
		if (pricing !== undefined || bootstrappedRef.current) {
			return;
		}
		bootstrappedRef.current = true;

		const now = Date.now();
		const cached = readModelPricingCache(now, ttlHours);
		if (cached) {
			// Show cached data immediately, fresh or stale — a cache that is a
			// few hours past its TTL is still far more accurate than the
			// bundled snapshot. Only a *missing* cache leaves the snapshot in
			// place, and the source is what tells the user which one they got.
			setLoadedTable(cached.table);
			setSource(cached.stale ? "stale" : "cache");
			if (!cached.stale) {
				return;
			}
		}

		if (offline) {
			return;
		}

		// Background refresh. The cached table (or the snapshot, if there was
		// no cache at all) stays visible until this returns.
		runFetch(url, now)
			.then((next) => {
				if (next) {
					setLoadedTable(next);
					setSource("cache");
				}
			})
			.catch(() => undefined);
	}, [offline, pricing, ttlHours, url]);

	return (
		<ModelPricingContext.Provider
			value={{
				offline,
				snapshotDate: modelMetadataSnapshotDate,
				source,
				table,
			}}
		>
			{children}
		</ModelPricingContext.Provider>
	);
}

export const useModelPricing = (): ModelPricingState => {
	const context = useContext(ModelPricingContext);
	if (!context) {
		throw new Error(
			"useModelPricing must be used within a ModelPricingProvider"
		);
	}
	return context;
};
