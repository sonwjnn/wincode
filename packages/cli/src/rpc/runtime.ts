import type { RuntimeModules } from "./types";

export const loadRuntime = async (): Promise<RuntimeModules> => {
	const [capabilities, host, rpc] = await Promise.all([
		import("@wincode/tui/session-capabilities"),
		import("@wincode/tui/session-host"),
		import("@wincode/tui/session-rpc"),
	]);
	return {
		createAgentTurnId: rpc.createAgentTurnId,
		createSessionCapabilities: capabilities.createSessionCapabilities,
		createSessionHost: host.createSessionHost,
		createSessionUserMessage: rpc.createSessionUserMessage,
		isSupportedModelVariant: rpc.isSupportedModelVariant,
		modelSelectionSchema: rpc.modelSelectionSchema,
		normalizeModelVariant: rpc.normalizeModelVariant,
		resolveWorkspaceRoot: rpc.resolveWorkspaceRoot,
		toSessionId: rpc.toSessionId,
	};
};
