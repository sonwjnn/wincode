import type { ChatModelSelection, ThinkingLevel } from "@wincode/ai/models";
import type {
	SessionSdk,
	SessionSdkCapabilityCeiling,
	SessionSdkHandle,
	SessionSdkOperations,
} from "@wincode/coding-agent";
import type { DelegationTask, SessionId } from "./task-types";

export type SubagentChildSessionOptions = Readonly<{
	agentId: DelegationTask["agentId"];
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	model?: ChatModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

export type SubagentChildSessionOpenOptions = Readonly<{
	autoContinue?: boolean;
	view?: boolean;
}>;

export type SubagentChildSessionRestoreOptions =
	SubagentChildSessionOpenOptions &
		Readonly<{ capabilityCeiling?: SessionSdkCapabilityCeiling }>;

export type SubagentChildSession = Readonly<{
	dispose: () => Promise<void>;
	open: (
		options?: SubagentChildSessionOpenOptions
	) => Promise<SessionSdkHandle>;
	sessionId: SessionId;
}>;

export type SubagentChildSessionFactory = Readonly<{
	create: (
		options: SubagentChildSessionOptions
	) => Promise<SubagentChildSession>;
	open: (
		sessionId: SessionId,
		options?: SubagentChildSessionRestoreOptions
	) => Promise<SubagentChildSession>;
}>;

const createChildSession = (
	sdk: SessionSdk,
	sessionId: SessionId
): SubagentChildSession => {
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let handle: SessionSdkHandle | undefined;
	let opening: Promise<SessionSdkHandle> | undefined;

	const open: SubagentChildSession["open"] = (options) => {
		if (disposed) {
			throw new Error("Subagent child Session is disposed.");
		}
		if (handle !== undefined || opening !== undefined) {
			throw new Error("Subagent child Session is already open.");
		}
		const pending = sdk.openSession(sessionId, options).then(async (opened) => {
			if (disposed) {
				await opened.dispose();
				throw new Error("Subagent child Session was disposed while opening.");
			}
			handle = opened;
			return opened;
		});
		opening = pending;
		return pending.finally(() => {
			if (opening === pending) {
				opening = undefined;
			}
		});
	};

	const dispose = (): Promise<void> => {
		if (disposePromise !== undefined) {
			return disposePromise;
		}
		disposed = true;
		const pendingOpen = opening;
		const closing = (async () => {
			await pendingOpen?.catch(() => undefined);
			const openedHandle = handle;
			handle = undefined;
			await Promise.allSettled([
				...(openedHandle === undefined ? [] : [openedHandle.dispose()]),
				sdk.dispose(),
			]);
		})();
		disposePromise = closing;
		return closing;
	};

	return Object.freeze({ dispose, open, sessionId });
};

/** Owns Subagents' child-session setup while using the host's generic Session SDK. */
export const createSubagentChildSessionFactory = (
	sessionSdk: SessionSdkOperations,
	pluginPath: string
): SubagentChildSessionFactory => {
	const createChildRuntime = (
		capabilityCeiling?: SessionSdkCapabilityCeiling
	) =>
		sessionSdk.createSessionRuntime({
			...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
			pluginPaths: [pluginPath],
		});

	return Object.freeze({
		create: async (options) => {
			const sdk = await createChildRuntime(options.capabilityCeiling);
			try {
				const sessionId = await sdk.createEmptySession({
					agent: options.agentId,
					...(options.model === undefined ? {} : { model: options.model }),
					...(options.thinkingLevel === undefined
						? {}
						: { thinkingLevel: options.thinkingLevel }),
				});
				return createChildSession(sdk, sessionId);
			} catch (error) {
				await sdk.dispose().catch(() => undefined);
				throw error;
			}
		},
		open: async (sessionId, options) => {
			const { capabilityCeiling, ...openOptions } = options ?? {};
			const sdk = await createChildRuntime(capabilityCeiling);
			const childSession = createChildSession(sdk, sessionId);
			try {
				await childSession.open(openOptions);
				return childSession;
			} catch (error) {
				await childSession.dispose();
				throw error;
			}
		},
	});
};
