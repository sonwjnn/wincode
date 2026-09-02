import { supportedChatModelIds } from "@wincode/ai/models";
import { env } from "@wincode/env/cli";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { fetchModelPricingTable } from "../fetch-model-pricing";
import type { ModelPricingTable } from "../model-pricing";
import {
	readModelPricingCache,
	writeModelPricingCache,
} from "../model-pricing-cache";
import { modelPricingSnapshot } from "../model-pricing-snapshot.generated";

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_URL = "https://models.dev/api.json";
const modelIds = new Set<string>(supportedChatModelIds);

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
	table: ModelPricingTable;
};

const ModelPricingContext = createContext<ModelPricingState | null>(null);

export function ModelPricingProvider({ children }: { children: ReactNode }) {
	const offline = env.WINCODE_MODEL_PRICING_OFFLINE === true;
	const ttlHours = env.WINCODE_MODEL_PRICING_TTL_HOURS ?? DEFAULT_TTL_HOURS;
	const url = env.WINCODE_MODEL_PRICING_URL ?? DEFAULT_URL;

	const [table, setTable] = useState<ModelPricingTable>(modelPricingSnapshot);
	const bootstrappedRef = useRef(false);

	useEffect(() => {
		if (bootstrappedRef.current) {
			return;
		}
		bootstrappedRef.current = true;

		const now = Date.now();
		const cached = readModelPricingCache(now, ttlHours);
		if (cached) {
			// Show cached data immediately, fresh or stale — a cache that is a
			// few hours past its TTL is still far more accurate than the
			// bundled snapshot. Only a *missing* cache falls back to it.
			setTable(cached.table);
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
					setTable(next);
				}
			})
			.catch(() => undefined);
	}, [offline, ttlHours, url]);

	return (
		<ModelPricingContext.Provider value={{ offline, table }}>
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
