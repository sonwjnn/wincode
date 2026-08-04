export type Source = { scope: "global" | "project"; path: string };
export type Merged = {
	value: Record<string, unknown>;
	sources: Map<string, Source>;
};
const nested = new Set(["headers", "environment", "timeout"]);
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const merge = (
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
	global: Source,
	project: Source
): Merged => {
	const value: Record<string, unknown> = Object.create(null);
	const sources = new Map<string, Source>();
	for (const [key, val] of Object.entries(base)) {
		value[key] = val;
		sources.set(key, global);
		if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			for (const leaf of Object.keys(val)) {
				sources.set(`${key}.${leaf}`, global);
			}
		}
	}
	for (const [key, val] of Object.entries(overlay)) {
		if (nested.has(key) && record(value[key]) && record(val)) {
			value[key] = {
				...value[key],
				...val,
			};
		} else {
			value[key] = val;
		}
		sources.set(key, project);
		if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			for (const leaf of Object.keys(val)) {
				sources.set(`${key}.${leaf}`, project);
			}
		}
	}
	return { value, sources };
};
