import {
	getErrorMessage,
	isNonEmptyString,
	omitUndefined,
} from "@wincode/utils";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type {
	CompactionLifecycle,
	CompactionLifecycleContext,
} from "../compaction/types";

/**
 * Translates the public Plugin compaction hooks into the bounded lifecycle the
 * Session Compaction module owns. The Plugin never receives transcript text,
 * never chooses a cut boundary, and never appends a compaction entry itself.
 */
export const createPluginCompactionLifecycle = ({
	getRuntime,
	workspace,
}: {
	getRuntime: () => PluginRuntime;
	workspace: string;
}): CompactionLifecycle => {
	const pluginContext = (
		context: CompactionLifecycleContext,
		signal: AbortSignal
	) => ({
		...omitUndefined({
			focus: context.focus,
			turnId: context.turnId,
		}),
		sessionId: context.sessionId,
		signal,
		trigger: context.trigger,
		workspace,
	});
	return {
		async before(context) {
			const runtime = getRuntime();
			const decision = await runtime.runBeforeCompactionHooks(
				pluginContext(context, context.signal ?? new AbortController().signal)
			);
			if (decision === undefined) {
				return;
			}
			return {
				...omitUndefined({
					cancel: isNonEmptyString(decision.cancel)
						? decision.cancel.trim()
						: undefined,
					summary: isNonEmptyString(decision.summary)
						? decision.summary
						: undefined,
				}),
			};
		},
		async completed(entry, context) {
			await getRuntime().notifyCompactionCompleted({
				...pluginContext(
					context,
					context.signal ?? new AbortController().signal
				),
				compactionId: entry.id,
				estimatedTokensAfter: entry.estimatedTokensAfter,
				tokensBefore: entry.tokensBefore,
			});
		},
		async failed(context) {
			await getRuntime().notifyCompactionFailed({
				...pluginContext(
					context,
					context.signal ?? new AbortController().signal
				),
				error: getErrorMessage(context.error, "Session compaction failed."),
			});
		},
	};
};
