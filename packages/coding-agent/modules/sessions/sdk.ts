import * as os from "node:os";
import type { AgentId, AgentTurnEvent } from "@wincode/agent-core";
import { agentIdSchema } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	type Effort,
	type ReasoningMode,
} from "@wincode/ai/models";
import { omitUndefined } from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import {
	createApplicationPluginComposition,
	type OptionalApplicationPluginId,
} from "@/modules/application/plugin-composition";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type {
	LiveSessionSnapshot,
	SessionContinuationOutcome,
	SessionSubmissionAdmission,
} from "@/modules/sessions/agent-session/types";
import {
	createSessionCapabilities,
	type SessionCapabilitiesAssembly,
	type SessionCapabilitiesOptions,
} from "@/modules/sessions/host/session-capabilities";
import type { SessionHost } from "@/modules/sessions/host/types";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";

export type SessionSdkPrompt = Readonly<{
	agent?: AgentId | string;
	effort?: Effort;
	model?: ChatModelSelection;
	reasoningMode?: ReasoningMode;
	text: string;
}>;

export type SessionSdkCreateOptions = Readonly<{
	agent?: AgentId | string;
	effort?: Effort;
	initialPrompt?: string;
	model?: ChatModelSelection;
	reasoningMode?: ReasoningMode;
}>;

export type SessionSdkHandle = Readonly<{
	continue: () => SessionContinuationOutcome;
	dispose: () => Promise<void>;
	onEvent: (listener: (event: AgentTurnEvent) => void) => () => void;
	prompt: (input: SessionSdkPrompt) => Promise<SessionSubmissionAdmission>;
	sessionId: SessionId;
	subscribe: (listener: (snapshot: LiveSessionSnapshot) => void) => () => void;
}>;

export type SessionSdkOptions = Omit<
	SessionCapabilitiesOptions,
	"cwd" | "pluginRuntime" | "workspace"
> &
	Readonly<{
		agent?: AgentId | string;
		cwd?: string;
		enabledPlugins?: readonly OptionalApplicationPluginId[];
		model?: ChatModelSelection;
		pluginPaths?: readonly string[];
		workspace?: string;
	}>;

export type SessionSdk = Readonly<{
	createSession: (
		options?: SessionSdkCreateOptions
	) => Promise<SessionSdkHandle>;
	dispose: () => Promise<void>;
	openSession: (sessionId: SessionId | string) => Promise<SessionSdkHandle>;
}>;

type SessionSelectionDefaults = Readonly<{
	agent: AgentId;
	model: ChatModelSelection;
}>;

const parseAgent = (value: AgentId | string): AgentId => {
	const parsed = agentIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Invalid Agent Identifier: ${value}`);
	}
	return parsed.data;
};

const defaultsFor = (
	registry: AgentRegistry | null,
	options: Pick<SessionSdkOptions, "agent" | "model">
): SessionSelectionDefaults => {
	const agent =
		options.agent === undefined
			? (registry?.defaultAgentId ?? DEFAULT_AGENT_ID)
			: parseAgent(options.agent);
	const selectedAgent = registry?.agents.find(
		(candidate) => candidate.id === agent && candidate.isAvailable
	);
	return {
		agent,
		model: options.model ?? selectedAgent?.model ?? defaultChatModelSelection,
	};
};

const resolvedAgentFor = (
	registry: AgentRegistry | null,
	agent: AgentId
): SessionSendInput["resolvedAgent"] => {
	const candidate = registry?.agents.find(
		(item) => item.id === agent && item.isAvailable
	);
	if (registry !== null && candidate === undefined) {
		throw new Error(`Agent is unavailable: ${agent}`);
	}
	return candidate === undefined
		? undefined
		: {
				id: candidate.id,
				instructions: candidate.instructions,
				role: candidate.role,
				...(candidate.requiresManualApproval
					? { requiresManualApproval: true }
					: {}),
				visibleCodingTools: [...candidate.visibleCodingTools],
			};
};

const promptInputFor = (
	input: SessionSdkPrompt,
	defaults: SessionSelectionDefaults,
	registry: AgentRegistry | null
): SessionSendInput => {
	if (input.effort !== undefined && input.reasoningMode !== undefined) {
		throw new Error("Select either Effort or Reasoning Mode, not both.");
	}
	const agent =
		input.agent === undefined ? defaults.agent : parseAgent(input.agent);
	const model = input.model ?? defaults.model;
	return {
		agent,
		composition: { files: [], text: input.text },
		model,
		resolvedAgent: resolvedAgentFor(registry, agent),
		sessionModel: defaults.model,
		...(input.effort === undefined ? {} : { effort: input.effort }),
		...(input.reasoningMode === undefined
			? {}
			: { reasoningMode: input.reasoningMode }),
		...(input.effort === undefined ? {} : { sessionEffort: input.effort }),
		...(input.reasoningMode === undefined
			? {}
			: { sessionReasoningMode: input.reasoningMode }),
		userText: input.text,
	};
};

const handleFor = (
	assembly: SessionCapabilitiesAssembly,
	host: SessionHost,
	sessionId: SessionId,
	defaults: SessionSelectionDefaults
): SessionSdkHandle => {
	const { capabilities } = assembly;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	return Object.freeze({
		continue: () => host.agentSession.continue(),
		dispose: () => {
			if (disposePromise !== undefined) {
				return disposePromise;
			}
			disposed = true;
			const closing = capabilities
				.getSessionHostManager()
				.releaseView(sessionId);
			disposePromise = closing;
			return closing;
		},
		onEvent: host.onEvent,
		prompt: async (input) => {
			if (disposed) {
				return { reason: "Session handle is disposed.", rejected: true };
			}
			return host.agentSession.prompt(
				promptInputFor(input, defaults, capabilities.getRegistry())
			);
		},
		sessionId,
		subscribe: (listener) => {
			if (disposed) {
				return () => undefined;
			}
			listener(host.getSnapshot());
			return host.subscribe(() => listener(host.getSnapshot()));
		},
	});
};

/** Creates a public, caller-owned Session SDK over the Coding-Agent Host. */
export const createSessionSdk = async (
	options: SessionSdkOptions = {}
): Promise<SessionSdk> => {
	const workspace = options.workspace ?? process.cwd();
	const cwd = options.cwd ?? workspace;
	const configStore =
		options.configStore ??
		options.configRuntime?.configStore ??
		createConfigStore();
	const configRuntime: ConfigRuntime = options.configRuntime ?? {
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	};
	const pluginRuntime: PluginRuntime = await loadPlugins({
		cliPaths: options.pluginPaths ?? [],
		config: configRuntime,
	});
	const {
		agent,
		cwd: _cwd,
		enabledPlugins = [],
		model,
		pluginPaths: _pluginPaths,
		workspace: _workspace,
		...capabilityOptions
	} = options;
	const composition = createApplicationPluginComposition({
		configStore,
		enabledPlugins,
		workspace,
	});
	const assembly = await createSessionCapabilities({
		...capabilityOptions,
		configRuntime,
		cwd,
		pluginRuntime,
		...(composition.mcpResource === undefined
			? {}
			: { mcpResource: composition.mcpResource }),
		...(composition.createDelegationAdapter === undefined
			? {}
			: { createDelegationAdapter: composition.createDelegationAdapter }),
		...(composition.createDelegationRuntime === undefined
			? {}
			: { createDelegationRuntime: composition.createDelegationRuntime }),
		turnToolResolver: composition.turnToolResolver,
		workspace,
	});
	const handles = new Set<SessionSdkHandle>();
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const defaultSelection = defaultsFor(assembly.capabilities.getRegistry(), {
		...(agent === undefined ? {} : { agent }),
		...(model === undefined ? {} : { model }),
	});
	const openSession = async (
		id: SessionId | string,
		selection = defaultSelection
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const sessionId = toSessionId(id);
		const host = await assembly.capabilities.getSessionHostManager().openHost({
			capabilities: assembly.capabilities,
			sessionId,
			view: true,
		});
		const stored = await assembly.store.getSession(sessionId);
		const prior = host.getSelection();
		const defaults = {
			agent: prior?.agent ?? selection.agent,
			model: prior?.model ?? stored.model ?? selection.model,
		};
		const handle = handleFor(assembly, host, sessionId, defaults);
		handles.add(handle);
		return handle;
	};
	const createSession = async (
		createOptions?: SessionSdkCreateOptions
	): Promise<SessionSdkHandle> => {
		if (disposed) {
			throw new Error("Session SDK is disposed.");
		}
		const selection = defaultsFor(
			assembly.capabilities.getRegistry(),
			omitUndefined({
				agent: createOptions?.agent ?? agent,
				model: createOptions?.model ?? model,
			})
		);
		const { id } = await assembly.store.createEmptySession(
			omitUndefined({
				model: selection.model,
				effort: createOptions?.effort,
				reasoningMode: createOptions?.reasoningMode,
			})
		);
		const handle = await openSession(id, selection);
		if (createOptions?.initialPrompt !== undefined) {
			const admission = await handle.prompt({
				text: createOptions.initialPrompt,
				...omitUndefined({
					agent: createOptions.agent,
					effort: createOptions.effort,
					model: createOptions.model,
					reasoningMode: createOptions.reasoningMode,
				}),
			});
			if (admission.rejected) {
				await handle.dispose();
				throw new Error(admission.reason);
			}
		}
		return handle;
	};
	return Object.freeze({
		createSession,
		dispose: () => {
			if (disposePromise !== undefined) {
				return disposePromise;
			}
			disposed = true;
			const closing = (async () => {
				await Promise.allSettled(
					[...handles].map((handle) => handle.dispose())
				);
				await assembly.shutdown();
			})();
			disposePromise = closing;
			return closing;
		},
		openSession,
	});
};
