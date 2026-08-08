#!/usr/bin/env bun
/**
 * Regenerate the bundled model-pricing snapshot and the opencode-go
 * model-variants snapshot.
 *
 * Usage:
 *   WINCODE_MODEL_PRICING_URL=https://models.dev/api.json bun run scripts/sync-model-pricing.ts
 *
 * Default URL: https://models.dev/api.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ModelVariant,
	modelVariantIds,
	supportedChatModelIds,
	supportedChatModels,
} from "@wincode/ai";
import { billingPricebook } from "@wincode/billing";
import {
	type ModelPricingEntry,
	modelPricingKey,
} from "../apps/cli/src/modules/model-pricing/model-pricing";
import { buildModelPricingTable } from "../apps/cli/src/modules/model-pricing/models-dev-response";

const DEFAULT_URL = "https://models.dev/api.json";

const OVERRIDES: Record<string, ModelPricingEntry> = {
	// OAuth-only models — context limits from public docs, no per-token price.
	"openai/gpt-5-codex": { contextLimit: 400_000 },
	"openai/gpt-5.1-codex": { contextLimit: 400_000 },
	"openai/gpt-5.1-codex-max": { contextLimit: 400_000 },
	"openai/gpt-5.2-codex": { contextLimit: 400_000 },
	"openai/gpt-5.1-chat-latest": { contextLimit: 400_000 },
};

const variantValues = new Set<string>(modelVariantIds);
const BUDGET_MAX_CAP = 31_999;
/** SDKs whose models.dev `budget_tokens` option maps to a thinking budget. */
const BUDGET_CAPABLE_SDK = new Set(["anthropic", "google"]);

export type ModelVariantsEntry = {
	kind?: "toggle";
	budget?: { high: number; max: number };
	variants: readonly ModelVariant[];
};

const effortVariants = (options: unknown): readonly ModelVariant[] => {
	if (!Array.isArray(options)) {
		return [];
	}
	const variants: ModelVariant[] = [];
	for (const option of options) {
		if (option?.type !== "effort") {
			continue;
		}
		for (const value of option.values ?? []) {
			if (
				typeof value === "string" &&
				variantValues.has(value) &&
				!variants.includes(value as ModelVariant)
			) {
				variants.push(value as ModelVariant);
			}
		}
	}
	return variants;
};

const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13";
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04";
const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"] as const;
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/;
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/;
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/;
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/;
const CLAUDE_VERSION_RE =
	/claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i;

const openaiVersionedEfforts = (id: string, version: number | undefined) => {
	if (GPT5_VERSIONED_PRO_RE.test(id)) {
		return ["medium", "high", "xhigh"];
	}
	if (version !== undefined) {
		return version === 1
			? ["none", "low", "medium", "high"]
			: ["none", "low", "medium", "high", "xhigh"];
	}
	return;
};

const openaiReasoningEfforts = (
	id: string,
	releaseDate: string
): readonly ModelVariant[] => {
	const chatVersion = GPT5_VERSION_RE.exec(id);
	if (id.includes("-chat")) {
		return chatVersion ? ["medium"] : [];
	}
	if (GPT5_PRO_RE.test(id)) {
		return ["high"];
	}
	if (id.includes("codex")) {
		const version = Number(chatVersion?.[1]) || undefined;
		if (version !== undefined && version >= 3) {
			return ["none", "low", "medium", "high", "xhigh"];
		}
		if (id.includes("codex-max") || (version !== undefined && version >= 2)) {
			return ["low", "medium", "high", "xhigh"];
		}
		return ["low", "medium", "high"];
	}
	const versioned = openaiVersionedEfforts(
		id,
		Number(chatVersion?.[1]) || undefined
	);
	if (versioned) {
		return versioned;
	}
	const efforts: ModelVariant[] = [...WIDELY_SUPPORTED_EFFORTS];
	if (GPT5_FAMILY_RE.test(id)) {
		efforts.unshift("minimal");
	}
	if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) {
		efforts.unshift("none");
	}
	if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) {
		efforts.push("xhigh");
	}
	return efforts;
};

const anthropicAdaptiveEfforts = (
	id: string
): readonly ModelVariant[] | null => {
	const version = CLAUDE_VERSION_RE.exec(id);
	if (!version) {
		return null;
	}
	const major = Number(version[1]);
	const minor = Number(version[2] ?? 0);
	if (major > 4 || (major === 4 && minor >= 7)) {
		return ["low", "medium", "high", "xhigh", "max"];
	}
	if (
		[
			"opus-4-6",
			"opus-4.6",
			"4-6-opus",
			"4.6-opus",
			"sonnet-4-6",
			"sonnet-4.6",
			"4-6-sonnet",
			"4.6-sonnet",
		].some((value) => id.includes(value))
	) {
		return ["low", "medium", "high", "max"];
	}
	return null;
};

/**
 * Mirrors opencode's SDK-specific variant heuristics (`variants()` in
 * `packages/opencode/src/provider/transform.ts`), applied when models.dev
 * `reasoning_options` contribute nothing.
 */
const baseVariants = (
	sdk: string,
	id: string,
	releaseDate: string | undefined
): readonly ModelVariant[] => {
	const lower = id.toLowerCase();
	switch (sdk) {
		case "openai":
			return openaiReasoningEfforts(lower, releaseDate ?? "");
		case "openai-compatible": {
			if (lower.includes("north-mini-code")) {
				return ["none", "high"];
			}
			const efforts: ModelVariant[] = [...WIDELY_SUPPORTED_EFFORTS];
			if (lower.includes("deepseek-v4")) {
				efforts.push("max");
			}
			return efforts;
		}
		case "anthropic": {
			const adaptive = anthropicAdaptiveEfforts(lower);
			if (adaptive) {
				return adaptive;
			}
			if (["opus-4-5", "opus-4.5"].some((value) => lower.includes(value))) {
				return ["low", "medium", "high"];
			}
			return ["high", "max"];
		}
		case "google": {
			if (lower.includes("2.5")) {
				return ["high", "max"];
			}
			if (!lower.includes("gemini-3")) {
				return ["low", "high"];
			}
			if (lower.includes("flash-image")) {
				return ["minimal", "high"];
			}
			if (lower.includes("pro-image")) {
				return ["high"];
			}
			if (lower.includes("flash")) {
				return ["minimal", "low", "medium", "high"];
			}
			return ["low", "medium", "high"];
		}
		default:
			return [];
	}
};

const budgetVariants = (
	options: unknown[],
	sdk: string,
	entry: unknown
): ModelVariantsEntry | null => {
	const budget = options.find((option) => option?.type === "budget_tokens");
	if (!(budget && BUDGET_CAPABLE_SDK.has(sdk))) {
		return null;
	}
	const outputLimit = (entry as { limit?: { output?: number } } | undefined)
		?.limit?.output;
	const maximum = Math.min(
		typeof budget.max === "number" ? budget.max : BUDGET_MAX_CAP,
		outputLimit === undefined ? BUDGET_MAX_CAP : outputLimit - 1,
		BUDGET_MAX_CAP
	);
	if (maximum <= 0) {
		return null;
	}
	const high = Math.min(
		Math.max(
			typeof budget.min === "number" ? budget.min : 0,
			Math.floor((maximum + 1) / 2)
		),
		maximum
	);
	return { variants: ["high", "max"], budget: { high, max: maximum } };
};

/**
 * Maps models.dev `reasoning_options` to catalog variants, mirroring
 * opencode's `reasoningVariants ?? variants(base)`: effort values map
 * verbatim; `budget_tokens` maps to `high`/`max` thinking budgets on
 * budget-capable SDKs (half and full budget, capped by the model's output
 * limit); an empty options array means no variants at all. When the options
 * contribute nothing (toggle-only or absent), the SDK-specific base
 * heuristics apply. MiniMax M3 via the Anthropic SDK is a curated
 * exception: it exposes `none`/`thinking` rather than effort levels.
 */
const toModelVariantsEntry = (
	options: unknown,
	model: { id: string; sdk: string },
	entry: unknown
): ModelVariantsEntry => {
	const effort = effortVariants(options);
	if (effort.length > 0) {
		return { variants: effort };
	}
	if (model.id === "minimax-m3") {
		return { kind: "toggle", variants: ["none", "thinking"] };
	}
	if (Array.isArray(options)) {
		if (options.length === 0) {
			return { variants: [] };
		}
		const budget = budgetVariants(options, model.sdk, entry);
		if (budget) {
			return budget;
		}
	}
	const releaseDate = (entry as { release_date?: string } | undefined)
		?.release_date;
	return { variants: baseVariants(model.sdk, model.id, releaseDate) };
};

const url = process.env.WINCODE_MODEL_PRICING_URL ?? DEFAULT_URL;

const fetchRaw = async (source: string): Promise<unknown> => {
	if (source.startsWith("http")) {
		const response = await fetch(source, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			throw new Error(`fetch ${source} → ${response.status}`);
		}
		return response.json();
	}
	return JSON.parse(readFileSync(source, "utf8"));
};

const main = async () => {
	const raw = await fetchRaw(url);
	const ids = new Set<string>(supportedChatModelIds);
	const table = buildModelPricingTable(raw, ids);

	const finalTable: Record<string, ModelPricingEntry> = { ...table };
	let overrideCount = 0;
	for (const [key, entry] of Object.entries(OVERRIDES)) {
		finalTable[key] = entry;
		overrideCount++;
	}

	// Verify every catalog entry has SOME entry under its own (provider, id)
	// key. `endsWith("/id")` would also match a reseller sharing the same
	// literal id under a different provider prefix, so match the exact key.
	const missing: string[] = [];
	for (const model of supportedChatModels) {
		const key = modelPricingKey(model.provider, model.id);
		if (!(key in finalTable)) {
			missing.push(key);
		}
	}

	const microsToUsd = (micros: bigint): number => Number(micros) / 1_000_000;
	for (const id of ["gpt-5.4-mini", "gemini-2.5-flash"]) {
		const live = finalTable[`openai/${id}`] ?? finalTable[`google/${id}`];
		const pricebookEntry =
			billingPricebook.models[id as keyof typeof billingPricebook.models];
		if (pricebookEntry && live?.cost) {
			const expectedInput = microsToUsd(
				pricebookEntry.inputMicrosPerMillionTokens
			);
			const drift = Math.abs(live.cost.input - expectedInput) > 0.01;
			if (drift) {
				console.warn(
					`warning: hosted price drift for ${id}: live=${live.cost.input} pricebook=${expectedInput}`
				);
			}
		}
	}

	const withCost = Object.values(finalTable).filter((e) => e.cost).length;
	const withLimit = Object.values(finalTable).filter(
		(e) => e.contextLimit > 0
	).length;
	const total = Object.keys(finalTable).length;
	console.log(
		`models with cost: ${withCost}/${total} | context limits: ${withLimit}/${total} | overrides: ${overrideCount}`
	);
	if (missing.length > 0) {
		console.warn(
			`warning: ${missing.length} catalog ids have no entry in the snapshot:`,
			missing
		);
	}

	const date = new Date().toISOString().slice(0, 10);
	const outPath = join(
		dirname(new URL(import.meta.url).pathname),
		"..",
		"apps/cli/src/modules/model-pricing/model-pricing-snapshot.generated.ts"
	);
	const serialized = Object.fromEntries(
		Object.entries(finalTable).sort(([a], [b]) => a.localeCompare(b))
	);
	const body = `// Generated by scripts/sync-model-pricing.ts — do not edit.
// Snapshot date: ${date}. Source: ${url}.

import type { ModelPricingTable } from "./model-pricing";

export const modelPricingSnapshot: ModelPricingTable = Object.freeze(${JSON.stringify(serialized, null, 2)});
`;
	writeFileSync(outPath, body);
	console.log(`Wrote ${outPath}`);

	const directVariants: Record<string, ModelVariantsEntry> = {};
	for (const model of supportedChatModels) {
		if (model.connectionProviderId === "wincode") {
			continue;
		}
		const providerBlock = (
			raw as Record<string, { models?: Record<string, unknown> }>
		)[model.provider];
		const entry = providerBlock?.models?.[model.id];
		directVariants[`${model.connectionProviderId}/${model.id}`] =
			toModelVariantsEntry(
				entry instanceof Object ? entry.reasoning_options : undefined,
				{
					id: model.id,
					sdk: "sdk" in model ? model.sdk : model.provider,
				},
				entry
			);
	}
	const variantsPath = join(
		dirname(new URL(import.meta.url).pathname),
		"..",
		"packages/ai/src/generated/model-variants.generated.ts"
	);
	mkdirSync(dirname(variantsPath), { recursive: true });
	const variantsBody = `// Generated by scripts/sync-model-pricing.ts — do not edit.
// Snapshot date: ${date}. Source: ${url}.

import type { ModelVariant } from "../models";

export type ModelVariantsEntry = {
	kind?: "toggle";
	budget?: { high: number; max: number };
	variants: readonly ModelVariant[];
};

export const modelVariantsByProviderModel: Readonly<Record<string, ModelVariantsEntry>> = ${JSON.stringify(directVariants, null, 2)};
`;
	writeFileSync(variantsPath, variantsBody);
	console.log(`Wrote ${variantsPath}`);
};

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
