import type {
	Provider,
	ProviderChatContext,
	ProviderChatEvent,
	ProviderChatRequest,
	ProviderModel,
} from "../sdk.ts";

/** One deterministic response. No HTTP, credentials, or model inference. */
export type FauxResponse = Readonly<{
	events?: readonly ProviderChatEvent[];
	/** Delay before each event; cancellation interrupts the delay. */
	delayMs?: number;
	/** Hold after events until the caller aborts (for cancellation tests). */
	waitForAbort?: boolean;
	/** Throw after events, exercising the SDK's real failure mapping. */
	error?: string;
}>;

export type FauxCall = Readonly<{
	request: ProviderChatRequest;
	model: ProviderModel;
}>;

export type FauxResponseStep =
	| string
	| FauxResponse
	| ((
			call: FauxCall
	  ) => string | FauxResponse | Promise<string | FauxResponse>);

export type FauxProviderOptions = Readonly<{
	id?: string;
	modelId?: string;
	responses?: readonly FauxResponseStep[];
}>;

export type FauxProviderHandle = Readonly<{
	provider: Provider;
	model: ProviderModel;
	/** Snapshots, not references to the caller's mutable messages. */
	calls: readonly FauxCall[];
	setResponses: (responses: readonly FauxResponseStep[]) => void;
	appendResponses: (responses: readonly FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}>;

/** Text can be split explicitly to assert intermediate terminal frames. */
export const fauxText = (...chunks: readonly string[]): FauxResponse => ({
	events: chunks.map((delta) => ({ delta, type: "text-delta" })),
});

const wait = async (
	milliseconds: number | undefined,
	signal?: AbortSignal
): Promise<void> => {
	signal?.throwIfAborted();
	const deferred = Promise.withResolvers<void>();
	const onAbort = (): void => deferred.reject(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer =
		milliseconds === undefined
			? undefined
			: setTimeout(deferred.resolve, milliseconds);
	try {
		await deferred.promise;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		signal?.removeEventListener("abort", onAbort);
	}
};

async function* streamResponse(
	response: FauxResponse,
	signal?: AbortSignal
): AsyncIterable<ProviderChatEvent> {
	const events = response.events ?? [];
	const finishIndex = events.findIndex((event) => event.type === "finish");
	if (
		finishIndex !== -1 &&
		(finishIndex !== events.length - 1 ||
			response.error !== undefined ||
			response.waitForAbort)
	) {
		throw new Error(
			"Faux finish must be the last event of a successful response"
		);
	}
	for (const event of events) {
		if (response.delayMs !== undefined) {
			await wait(response.delayMs, signal);
		}
		signal?.throwIfAborted();
		yield structuredClone(event);
	}
	if (response.waitForAbort) {
		if (signal === undefined) {
			throw new Error("A held faux response requires an AbortSignal");
		}
		await wait(undefined, signal);
	}
	signal?.throwIfAborted();
	if (response.error !== undefined) {
		throw new Error(response.error);
	}
	if (finishIndex === -1) {
		yield { type: "finish" };
	}
}

/** Scripted Provider for real SDK/Agent/TUI consumers; never globally registered. */
export const createFauxProvider = (
	options: FauxProviderOptions = {}
): FauxProviderHandle => {
	const id = options.id ?? "faux";
	const model: ProviderModel = {
		capabilities: ["text", "tools"],
		modelId: options.modelId ?? "faux-1",
		protocolId: "faux",
		providerId: id,
	};
	let pending = [...(options.responses ?? [])];
	const calls: FauxCall[] = [];
	const provider: Provider = {
		id,
		models: [model],
		resolveAuthorization: () => ({ authorization: { kind: "faux" } }),
		async *streamChat(
			request: ProviderChatRequest,
			context: ProviderChatContext
		): AsyncIterable<ProviderChatEvent> {
			context.signal?.throwIfAborted();
			const call: FauxCall = {
				model: structuredClone(context.model),
				request: structuredClone(request),
			};
			calls.push(call);
			const step = pending.shift();
			if (step === undefined) {
				throw new Error("No more faux responses queued");
			}
			const result = typeof step === "function" ? await step(call) : step;
			const response = typeof result === "string" ? fauxText(result) : result;
			yield* streamResponse(response, context.signal);
		},
	};
	return {
		appendResponses: (responses) => {
			pending.push(...responses);
		},
		calls,
		getPendingResponseCount: () => pending.length,
		model,
		provider,
		setResponses: (responses) => {
			pending = [...responses];
		},
	};
};
