import type { SessionSdk } from "./modules/sessions/sdk-contract";
import type { SessionSdkOptions } from "./modules/sessions/sdk-options";

export * from "./modules/plugins/public";
export * from "./modules/sessions/public-contract";

/** Creates a caller-owned Session SDK over the Coding-Agent Host. */
export declare function createSessionSdk(
	options?: SessionSdkOptions
): Promise<SessionSdk>;
