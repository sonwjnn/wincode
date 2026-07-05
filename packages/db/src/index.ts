// biome-ignore lint/performance/noBarrelFile: package entry re-exporting the Drizzle client.
export {
	createDrizzleClient,
	type DrizzleClient,
	schema,
} from "./client";
