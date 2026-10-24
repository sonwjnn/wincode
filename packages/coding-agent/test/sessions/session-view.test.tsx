import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	MockTreeSitterClient,
	type TestRendererSetup,
} from "@opentui/core/testing";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentId, toSubmissionId } from "@wincode/agent-core";
import type {
	Provider,
	ProviderCollection,
	ProviderModel,
	ThinkingLevel,
} from "@wincode/ai";
import { isNull, isUndefined } from "@wincode/utils";
import {
	act,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { AgentRegistryProvider, useAgentRegistry } from "@/modules/agents";
import { loadPlugins } from "@/modules/plugins/loader";
import { createPluginPromptSelectionBridge } from "@/modules/plugins/prompt-selection";
import {
	createPluginRuntime,
	type PluginProviderDescriptor,
} from "@/modules/plugins/runtime";
import {
	PromptConfigProvider,
	usePromptConfig,
} from "@/modules/prompt-settings/context/prompt-config-provider";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
	type PluginProviderComposition,
} from "@/modules/providers/interactive-provider-controller";
import {
	createProviderModelSelectionSnapshot,
	DEFAULT_PROVIDER_MODEL_SELECTION,
	type ProviderModelSelection,
	type ProviderModelSelectionCandidate,
	providerModelSelectionCandidateForModel,
} from "@/modules/providers/provider-model-selection";
import type {
	SessionQueuedSubmission,
	SessionSteeringMessage,
	SessionSubmissionEvent,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "@/modules/sessions/agent-session/types";
import type { CompactSessionResult } from "@/modules/sessions/compaction/compaction";
import * as useAgentSessionModule from "@/modules/sessions/hooks/use-agent-session";
import { assertPluginProviderSelectionOwner } from "@/modules/sessions/host/agent-session-turn-runner";
import type {
	SessionCapabilities,
	SessionHost,
} from "@/modules/sessions/host/types";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { ResolvedSessionSelection } from "@/modules/sessions/selection";
import type {
	SessionSendInput,
	SessionSubmissionComposition,
} from "@/modules/sessions/submission-types";
import { setTreeSitterClientOverride } from "@/modules/sessions/ui/tree-sitter-client";
import { SessionView } from "@/modules/sessions/ui/views/session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import {
	type ConfigRuntime,
	type ConfigStore,
	createConfigStore,
} from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import { CommandControllerProvider } from "@/tui/commands/command-controller-provider";
import { testRenderWithClipboard } from "../support/clipboard";
import {
	agentId,
	attachmentId,
	modelId,
	queuedSubmissionId,
	sessionId,
	sessionMessageId,
	steeringMessageId,
} from "../support/identifiers";
import { captureTestFrame, frameIncludes } from "../support/opentui";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

type FakeSessionRun = {
	navigationRelease: Deferred<void>;
	navigationStarted: Deferred<void>;
	release: Deferred<void>;
	sendStarted: Deferred<void>;
};

let activeFakeSessionRun: FakeSessionRun | null = null;
let fakeCacheWarmCancellations = 0;
let fakeCompactionModels: ProviderModelSelection[] = [];
/** The compositions the view accepted while the turn ran, in order. */
let fakeWaitingTexts: string[] = [];
/** The same messages' full compositions, so a round trip can be asserted. */
let fakeWaitingCompositions: SessionSubmissionComposition[] = [];
/** The Submission Queue a test starts the view with, before anything is sent. */
let fakeQueuedSeed: SessionQueuedSubmission[] = [];
/** A Recall payload the test supplies, in place of what the fake lanes hold. */
let fakeRecalledPayload: SessionWaitingMessage[] | null = null;
/** The effective submission inputs the view sent while the session was idle. */
let fakeRunInputs: SessionSendInput[] = [];
/** The compositions the view sent while the session was idle, in order. */
let fakeRunCompositions: SessionSubmissionComposition[] = [];
/** How many times the view asked the session to recall its waiting messages. */
let fakeSessionRecalls = 0;
const fakeSubmissionEventListeners = new Set<
	(event: SessionSubmissionEvent) => void
>();
const subscribeToFakeSubmissionEvents = (
	listener: (event: SessionSubmissionEvent) => void
): (() => void) => {
	fakeSubmissionEventListeners.add(listener);
	return () => {
		fakeSubmissionEventListeners.delete(listener);
	};
};
const emitFakeSubmissionEvent = (event: SessionSubmissionEvent): void => {
	for (const listener of [...fakeSubmissionEventListeners]) {
		listener(event);
	}
};

/**
 * Drives the composer's queue and steering behavior without reaching the real
 * Agent Session. Installed as a spy on the module's live binding so the
 * already-imported Session View picks it up without a registry-wide module
 * mock.
 */
const fakeUseAgentSessionModule: Pick<
	typeof useAgentSessionModule,
	"useAgentSession"
> = {
	useAgentSession: (host: SessionHost) => {
		const [turnActive, setTurnActive] = useState(false);
		const [queuedSubmissions, setQueuedSubmissions] =
			useState<SessionQueuedSubmission[]>(fakeQueuedSeed);
		const [steeringMessages, setSteeringMessages] = useState<
			SessionSteeringMessage[]
		>([]);
		const [sentMessages, setSentMessages] = useState<SessionMessage[]>([]);
		// The opened facts the fake host holds, read once as the real binding
		// reads a Snapshot.
		const [opened] = useState(host.getSnapshot);
		const running = useRef(false);
		running.current = turnActive;
		const waiting = useRef<SessionWaitingMessage[]>([]);
		const steeringMessagesRef = useRef(steeringMessages);
		steeringMessagesRef.current = steeringMessages;
		waiting.current = [...queuedSubmissions];
		const enqueue = useCallback((input: SessionSendInput) => {
			const composition = input.composition ?? {
				files: input.files ?? [],
				text: input.userText ?? "",
			};
			const sequence = fakeWaitingTexts.length + 1;
			const messageId =
				input.messageId ??
				input.reservedMessageId ??
				sessionMessageId(`queued-message-${sequence}`);
			const submissionId =
				input.submissionId ?? toSubmissionId(`queued-submission-${sequence}`);
			fakeWaitingTexts = [...fakeWaitingTexts, composition.text];
			fakeWaitingCompositions = [...fakeWaitingCompositions, composition];
			setQueuedSubmissions((submissions) => [
				...submissions,
				fromPartial<SessionQueuedSubmission>({
					id: queuedSubmissionId(`queued-${sequence}`),
					input: { ...input, composition },
					messageId,
					submissionId,
				}),
			]);
			return {
				disposition: "queued" as const,
				messageId,
				rejected: false as const,
				submissionId,
			};
		}, []);
		const send = useCallback(
			async (input: SessionSendInput) => {
				const run = activeFakeSessionRun;
				if (!run) {
					throw new Error("No fake session run configured.");
				}
				if (running.current) {
					return enqueue(input);
				}
				const composition = input.composition ?? {
					files: input.files ?? [],
					text: input.userText ?? "",
				};
				fakeRunInputs = [...fakeRunInputs, input];
				fakeRunCompositions = [...fakeRunCompositions, composition];
				run.sendStarted.resolve();
				setTurnActive(true);
				await run.release.promise;
				setTurnActive(false);
				return {
					disposition: "started" as const,
					messageId:
						input.messageId ??
						input.reservedMessageId ??
						sessionMessageId("started-message"),
					rejected: false as const,
					submissionId:
						input.submissionId ?? toSubmissionId("started-submission"),
					...(input.turnId === undefined ? {} : { turnId: input.turnId }),
				};
			},
			[enqueue]
		);
		const prompt = useCallback(
			async (input: SessionSendInput) => {
				if (running.current) {
					return enqueue(input);
				}
				const run = activeFakeSessionRun;
				if (!run) {
					throw new Error("No fake session run configured.");
				}
				const composition = input.composition ?? {
					files: input.files ?? [],
					text: input.userText ?? "",
				};
				fakeRunInputs = [...fakeRunInputs, input];
				fakeRunCompositions = [...fakeRunCompositions, composition];
				const messageId =
					input.messageId ??
					input.reservedMessageId ??
					sessionMessageId("started-message");
				setSentMessages((messages) => [
					...messages,
					{
						id: messageId,
						metadata: { agent: input.agent, model: input.model },
						parts: [{ text: composition.text, type: "text" }],
						role: "user",
					},
				]);
				run.sendStarted.resolve();
				setTurnActive(true);
				void run.release.promise.then(() => setTurnActive(false));
				return {
					disposition: "started" as const,
					messageId:
						input.messageId ??
						input.reservedMessageId ??
						sessionMessageId("started-message"),
					rejected: false as const,
					submissionId:
						input.submissionId ?? toSubmissionId("started-submission"),
					...(input.turnId === undefined ? {} : { turnId: input.turnId }),
				};
			},
			[enqueue]
		);
		const steer = useCallback(async () => {
			if (!running.current) {
				return { kind: "empty" as const };
			}
			const queued = queuedSubmissions[0];
			if (queued === undefined) {
				return { kind: "empty" as const };
			}
			setQueuedSubmissions((submissions) => submissions.slice(1));
			setSteeringMessages((messages) => [
				...messages,
				fromPartial<SessionSteeringMessage>({
					id: steeringMessageId(`steering-${queued.id}`),
					input: {
						...queued.input,
						composition: queued.input.composition,
						messageId: queued.messageId,
						submissionId: queued.submissionId,
					},
					message: {
						id: queued.messageId,
						metadata: {
							submissionId: queued.submissionId,
							submissionStatus: "pending",
						},
						parts: [{ text: queued.input.composition.text, type: "text" }],
						role: "user",
					},
					recordId: `record-${queued.id}`,
					status: "pending",
				}),
			]);
			return {
				kind: "steered" as const,
				messageId: queued.messageId,
				submissionId: queued.submissionId,
				...(queued.input.turnId === undefined
					? {}
					: { turnId: queued.input.turnId }),
			};
		}, [queuedSubmissions]);
		const recallWaitingMessages = useCallback(
			async (ids?: readonly SessionWaitingMessageId[]) => {
				const lanes = fakeRecalledPayload ?? waiting.current;
				// Committed steering input is durable and cannot be recalled; only
				// queued submissions return to the composer.
				const recalled = isUndefined(ids)
					? lanes
					: lanes.filter((message) => ids.includes(message.id));
				if (recalled.length === 0) {
					return [];
				}
				const recalledIds = new Set(recalled.map(({ id }) => id));
				const remaining = waiting.current.filter(
					(message) => !recalledIds.has(message.id)
				);
				fakeSessionRecalls += 1;
				fakeWaitingCompositions = [
					...steeringMessagesRef.current.map(({ input }) => input.composition),
					...remaining.map(({ input }) => input.composition),
				];
				fakeWaitingTexts = [
					...steeringMessagesRef.current.map(
						({ input }) => input.composition.text
					),
					...remaining.map(({ input }) => input.composition.text),
				];
				setQueuedSubmissions((queue) =>
					queue.filter(({ id }) => !recalledIds.has(id))
				);
				return recalled;
			},
			[]
		);
		return {
			cacheWarmingStatus: "idle",
			cancel: () => undefined,
			cancelCompaction: async () => [],
			compact: async (_focus, selection) => {
				fakeCompactionModels = [...fakeCompactionModels, selection];
				return fromPartial<CompactSessionResult>({
					activeMessages: [],
					entry: {},
				});
			},
			interrupt: async () => [],
			onSubmissionEvent: subscribeToFakeSubmissionEvents,
			recallWaitingMessages,
			prompt,
			steer,
			send,
			sessionUsageEntries: [],
			snapshot: {
				...opened,
				context: [...opened.context, ...sentMessages],
				queuedSubmissions,
				steeringMessages,
				transcript: [...opened.transcript, ...sentMessages],
				turnActive,
			},
		};
	},
};
spyOn(useAgentSessionModule, "useAgentSession").mockImplementation(
	fakeUseAgentSessionModule.useAgentSession
);
const createTestConfigStore = (settings?: Readonly<Record<string, unknown>>) =>
	createConfigStore({
		fs: {
			readFile: async (file) => {
				if (
					settings !== undefined &&
					file === path.join(os.homedir(), ".wincode", "settings.json")
				) {
					return JSON.stringify(settings);
				}
				throw Object.assign(new Error("Test config is unavailable."), {
					code: "ENOENT",
				});
			},
		},
	});

function KeyboardLayerProbe({
	onLayer,
}: {
	onLayer: (isCommandLayer: boolean) => void;
}) {
	const { isTopLayer } = useKeyboardLayer();
	useEffect(() => {
		onLayer(isTopLayer("command"));
	});
	return null;
}

function AgentRegistryReadyProbe({ onReady }: { onReady: () => void }) {
	const registry = useAgentRegistry();
	useEffect(() => {
		if (!isNull(registry)) {
			onReady();
		}
	}, [onReady, registry]);
	return null;
}

function PromptModelProbe({
	onAgent,
	onModel,
}: {
	onAgent?: (agent: AgentId) => void;
	onModel: (model: ProviderModelSelection) => void;
}) {
	const { agent, model } = usePromptConfig();
	useEffect(() => onModel(model), [model, onModel]);
	useEffect(() => onAgent?.(agent), [agent, onAgent]);
	return null;
}

function ThinkingLevelProbe({
	onThinkingLevel,
}: {
	onThinkingLevel: (level: ThinkingLevel | undefined) => void;
}) {
	const { thinkingLevel } = usePromptConfig();
	useEffect(
		() => onThinkingLevel(thinkingLevel),
		[onThinkingLevel, thinkingLevel]
	);
	return null;
}

/** The strip's count line, e.g. `2 waiting`; the workspace path never has one. */
const WAITING_COUNT_PATTERN = /\d+ waiting/u;
/** A strip row of one lane, so a lane tag is read off the row it belongs to. */
const LANE_ROW = (lane: "queued", description: string): RegExp =>
	new RegExp(`${lane}\\s+${description}`, "u");

const userMessage = (id: string, text: string): SessionMessage => ({
	id: sessionMessageId(id),
	metadata: { agent: agentId("build") },
	parts: [{ text, type: "text" }],
	role: "user",
});

const buildRouter = () => {
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		component: () => null,
		getParentRoute: () => rootRoute,
		path: "/sessions/$id",
	});
	return createRouter({
		history: createMemoryHistory({ initialEntries: ["/sessions/session-1"] }),
		routeTree: rootRoute.addChildren([sessionRoute]),
	});
};

/**
 * The Session View's seam is an already-open Host, so the fake one carries the
 * opened facts a Snapshot publishes. The binding is mocked too, so the Host's
 * Agent Session is never reached from this test.
 */
const createFakeSessionHost = (
	transcript: readonly SessionMessage[],
	providerController?: InteractiveProviderController,
	selection?: ResolvedSessionSelection | null,
	assertPluginSnapshot: () => void = () => undefined
): SessionHost =>
	fromPartial<SessionHost>({
		...(providerController === undefined ? {} : { providerController }),
		agentSession: {},
		assertCurrentPluginProviderRegistrationSnapshot: assertPluginSnapshot,
		withSessionWork: <Result,>(action: () => Promise<Result>) => action(),
		cancelCacheWarming: () => {
			fakeCacheWarmCancellations += 1;
		},
		getSelection: () => selection ?? null,
		getSnapshot: () => ({
			catalogDiagnostic: null,
			compactions: [],
			compactionError: null,
			context: transcript,
			error: null,
			executions: [],
			isCompacting: false,
			queuedSubmissions: [],
			steeringMessages: [],
			transcript,
			turnActive: false,
			viewState: undefined,
		}),
	});

/**
 * Renders until the frame stops changing, so work whose commit is asynchronous
 * lands before an assertion reads it. The Session Surface opens its Session
 * Services before it opens a Session Host, and this harness can otherwise read
 * the frame in the middle of that window.
 */
const flushUi = async (setup: TestRendererSetup): Promise<void> => {
	await setup.waitForVisualIdle();
	let previous = captureTestFrame(setup) ?? "";
	// Two passes minimum: the first gives an asynchronous commit a window to
	// land, the second sees whether it did. A command slower than that needs a
	// wait of its own, which is what the assertions here rely on.
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await Bun.sleep(20);
		await setup.renderOnce();
		await setup.waitForVisualIdle();
		const frame = captureTestFrame(setup) ?? "";
		if (attempt >= 1 && frame === previous) {
			return;
		}
		previous = frame;
	}
};

const providerModelCandidate = (providerModel: ProviderModel) => {
	const snapshot = createProviderModelSelectionSnapshot([], [], 0);
	const candidate = providerModelSelectionCandidateForModel(
		providerModel,
		snapshot
	);
	if (candidate === undefined) {
		throw new Error("The fixture Provider Model must be a built-in model.");
	}
	return candidate;
};

const pluginPickerRegistration = (pluginId: string) =>
	fromPartial<PluginProviderDescriptor>({
		connect: async () => undefined,
		displayName: pluginId,
		pluginId,
		providerId: "plugin-picker-provider",
		sourceIdentity: `/plugins/${pluginId}.ts`,
	});

beforeAll(() => {
	setTreeSitterClientOverride(
		new MockTreeSitterClient({ autoResolveTimeout: 0 })
	);
});

afterAll(() => {
	mock.restore();
	setTreeSitterClientOverride(null);
});

afterEach(() => {
	activeFakeSessionRun = null;
	fakeCacheWarmCancellations = 0;
	fakeCompactionModels = [];
	fakeQueuedSeed = [];
	fakeRunCompositions = [];
	fakeRunInputs = [];
	fakeWaitingCompositions = [];
	fakeWaitingTexts = [];
	fakeRecalledPayload = null;
	fakeSessionRecalls = 0;
	fakeSubmissionEventListeners.clear();
});

test("manual compaction scopes its stored model check before global replacement discovery", async () => {
	const modelReads: string[] = [];
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async (providerId: string | undefined) => {
			modelReads.push(`selected:${providerId ?? "<all>"}`);
			return [];
		},
		getAvailableProviderModelSelectionCandidates: async () => {
			modelReads.push("global-chooser");
			return [];
		},
		getKnownModels: async () => [],
	});
	const { setup } = await renderSessionView({
		height: 30,
		initialTranscript: [],
		providerController,
		width: 100,
	});

	try {
		await act(async () => setup.mockInput.typeText("/compact"));
		await setup.waitForFrame((frame) =>
			frame.includes("Compact session history")
		);
		await act(() => setup.mockInput.pressTab());
		await flushUi(setup);
		await act(async () => setup.mockInput.typeText("preserve the history"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressEnter());
		await setup.waitForFrame((frame) =>
			frame.includes("Choose Model for Compaction")
		);
		await setup.waitFor(() => modelReads.length >= 2);
		expect(modelReads).toEqual(["selected:openai", "global-chooser"]);
	} finally {
		setup.renderer.destroy();
	}
});

test("manual compaction rejects a stale Host Plugin snapshot before Provider availability", async () => {
	let availabilityReads = 0;
	let snapshotChecks = 0;
	const providerModel: ProviderModel = {
		modelId: "gpt-5.6-luna",
		protocolId: "fake-provider",
		providerId: "openai",
	};
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => {
			availabilityReads += 1;
			return [providerModel];
		},
		getKnownModels: async () => [providerModel],
	});
	const { setup } = await renderSessionView({
		assertPluginSnapshot: () => {
			snapshotChecks += 1;
			throw new Error("An unrelated Host Plugin registration is stale.");
		},
		height: 30,
		initialTranscript: [],
		providerController,
		width: 100,
	});

	try {
		await act(async () => setup.mockInput.typeText("/compact"));
		await setup.waitForFrame((frame) =>
			frame.includes("Compact session history")
		);
		await act(() => setup.mockInput.pressTab());
		await flushUi(setup);
		await act(async () => setup.mockInput.typeText("preserve the history"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressEnter());
		await setup.waitForFrame((frame) =>
			frame.includes("unrelated Host Plugin registration is stale")
		);

		expect(snapshotChecks).toBe(1);
		expect(availabilityReads).toBe(0);
		expect(fakeCompactionModels).toHaveLength(0);
	} finally {
		setup.renderer.destroy();
	}
});

test("manual compaction replaces an unavailable Agent pin only with an available Provider Model", async () => {
	const pinnedAgent = agentId("offline-model-agent");
	const replacementModel: ProviderModel = {
		modelId: "replacement-model",
		protocolId: "fake-provider",
		providerId: "openai",
	};
	const replacementCandidate = providerModelCandidate(replacementModel);
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => [replacementModel],
		getAvailableProviderModelSelectionCandidates: async () => [
			replacementCandidate,
		],
		getKnownModels: async () => [],
		selectProviderModelSelectionCandidate: async <Result,>(
			candidate: ProviderModelSelectionCandidate,
			action: (
				model: ProviderModel,
				selection: ProviderModelSelection
			) => Result | Promise<Result>
		): Promise<Result> => await action(candidate.model, candidate.selection),
	});
	const { setup } = await renderSessionView({
		configSettings: {
			agents: {
				[pinnedAgent]: {
					description: "Keeps its unavailable OpenAI pin.",
					model: "openai/gpt-5.6-luna",
					role: "primary",
				},
			},
			default_agent: pinnedAgent,
		},
		height: 30,
		initialAgent: pinnedAgent,
		initialModel: DEFAULT_PROVIDER_MODEL_SELECTION,
		initialTranscript: [],
		providerController,
		width: 100,
	});

	try {
		await act(async () => setup.mockInput.typeText("/compact"));
		await setup.waitForFrame((frame) =>
			frame.includes("Compact session history")
		);
		await act(() => setup.mockInput.pressTab());
		await flushUi(setup);
		await act(async () => setup.mockInput.typeText("preserve the history"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressEnter());
		await setup.waitForFrame((frame) =>
			frame.includes("Choose Model for Compaction")
		);
		await setup.waitForFrame((frame) => frame.includes("replacement-model"));
		await act(() => setup.mockInput.pressEnter());
		await setup.waitFor(() => fakeCompactionModels.length === 1);

		expect(fakeCompactionModels).toEqual([
			{ modelId: modelId("replacement-model"), providerId: "openai" },
		]);
	} finally {
		setup.renderer.destroy();
	}
});

test("manual compaction rejects a fetched owner-A model after owner B replaces it", async () => {
	const providerModel: ProviderModel = {
		modelId: "same-model-id",
		protocolId: "fake-provider",
		providerId: "plugin-picker-provider",
	};
	let trustedRegistration = pluginPickerRegistration("owner-a");
	let hostRegistration = trustedRegistration;
	let trustedRuntime: object = {};
	let compositionRevision = 1;
	let availabilityReads = 0;
	const providerController = createInteractiveProviderController(
		fromPartial<ProviderCollection>({
			getAvailable: async () => {
				availabilityReads += 1;
				return [providerModel];
			},
			getModels: () => [providerModel],
			restoreModels: async () => undefined,
		}),
		{
			getCompositionRevision: () => compositionRevision,
			getPluginProviderRegistrations: () => [hostRegistration],
			getTrustedPluginProviderRegistrations: () => [trustedRegistration],
			getTrustedPluginProviderRuntime: () => trustedRuntime,
			withSessionWork: async (action) => await action(),
		}
	);
	const { setup } = await renderSessionView({
		height: 30,
		initialTranscript: [],
		providerController,
		width: 100,
	});

	try {
		await act(async () => setup.mockInput.typeText("/compact"));
		await setup.waitForFrame((frame) =>
			frame.includes("Compact session history")
		);
		await act(() => setup.mockInput.pressTab());
		await flushUi(setup);
		await act(async () => setup.mockInput.typeText("preserve the history"));
		await flushUi(setup);
		await act(() => setup.mockInput.pressEnter());
		await setup.waitForFrame((frame) =>
			frame.includes("Choose Model for Compaction")
		);
		await setup.waitForFrame((frame) => frame.includes("same-model-id"));

		trustedRegistration = pluginPickerRegistration("owner-b");
		hostRegistration = trustedRegistration;
		trustedRuntime = {};
		compositionRevision += 1;
		await act(() => setup.mockInput.pressEnter());
		await setup.waitForFrame((frame) =>
			frame.includes("Provider Model results are stale")
		);

		expect(availabilityReads).toBe(2);
		expect(fakeCompactionModels).toHaveLength(0);
	} finally {
		setup.renderer.destroy();
	}
});

describe("SessionView initial submission", () => {
	test("does not expose retry while the initial prompt is starting", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		let registryIsReady = false;
		let navigationHasStarted = false;
		activeFakeSessionRun = {
			navigationRelease,
			navigationStarted,
			release,
			sendStarted,
		};
		const router = buildRouter();
		await router.load();
		const navigate = router.navigate.bind(router);
		router.navigate = (...args) => {
			navigationHasStarted = true;
			navigationStarted.resolve();
			return navigationRelease.promise.then(() => navigate(...args));
		};
		const initialTranscript = [
			userMessage("initial-user", "create the session prompt"),
		];
		const configStore = createTestConfigStore();
		const workspace = process.cwd();
		const setup = await testRenderWithClipboard(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{ configStore, homeRoot: os.homedir(), workspace }}
				>
					<ToastProvider>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionView
													host={createFakeSessionHost(initialTranscript)}
													initialSubmission={{
														messageId: sessionMessageId("initial-user"),
													}}
													initialTranscript={initialTranscript}
													sessionId={sessionId("session-1")}
													sessionTitle="Create the session prompt"
												/>
												<AgentRegistryReadyProbe
													onReady={() => {
														registryIsReady = true;
													}}
												/>
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>,
			{ height: 30, width: 100 }
		);

		try {
			// The registry loads asynchronously, so readiness is awaited rather
			// than assumed after a fixed flush.
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			await setup.waitFor(() => navigationHasStarted);
			const frameBeforeSend = setup.captureCharFrame();
			expect(frameBeforeSend).toContain("create the session prompt");
			expect(frameBeforeSend).not.toContain("Retry");
			navigationRelease.resolve();
			await sendStarted.promise;
			await flushUi(setup);
			const frameAfterSend = setup.captureCharFrame();
			expect(frameAfterSend).toContain("create the session prompt");
			expect(frameAfterSend).not.toContain("Retry");
		} finally {
			navigationRelease.resolve();
			release.resolve();
			setup.renderer.destroy();
		}
	});
	/**
	 * Types into the composer until the composition is really there. The test
	 * renderer can deliver input before the submit-reset effect runs.
	 */
	const typePrompt = async (setup: TestRendererSetup, text: string) => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await setup.mockInput.typeText(text);
			await flushUi(setup);
			if (frameIncludes(setup, text)) {
				return;
			}
		}
		throw new Error(`The composer never held "${text}".`);
	};

	const createProviderRuntime = (
		providerId: string,
		owners: readonly Pick<
			PluginProviderDescriptor,
			"pluginId" | "sourceIdentity"
		>[],
		workspace: string
	) =>
		createPluginRuntime(
			owners.map(({ pluginId, sourceIdentity }) => ({
				commands: [],
				id: pluginId,
				providers: [
					{
						connect: async () => undefined,
						createProvider: () => fromPartial<Provider>({}),
						displayName: pluginId,
						pluginId,
						providerId,
						sourceIdentity,
						sourcePath: sourceIdentity,
					},
				],
				sourcePath: sourceIdentity,
				tools: [],
				workspace,
			})),
			[]
		);

	const expectPinRejectedBeforeProviderAvailability = async ({
		owners,
		restoredSelection,
	}: {
		owners: readonly Pick<
			PluginProviderDescriptor,
			"pluginId" | "sourceIdentity"
		>[];
		restoredSelection?: ResolvedSessionSelection;
	}): Promise<void> => {
		const providerId = "session-view-trusted-provider";
		const modelIdValue = "session-view-pinned-model";
		const pinnedAgent = agentId("session-view-plugin-pinned-agent");
		const workspace = process.cwd();
		const providerModel: ProviderModel = {
			modelId: modelId(modelIdValue),
			protocolId: "fake-provider",
			providerId,
		};
		const pluginRuntime =
			owners.length === 0
				? undefined
				: createProviderRuntime(providerId, owners, workspace);
		setInteractiveRuntimeContext({
			args: [],
			cwd: workspace,
			...(pluginRuntime === undefined ? {} : { pluginRuntime }),
		});
		let availabilityReads = 0;
		let credentialReads = 0;
		let modelStoreReads = 0;
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => {
				availabilityReads += 1;
				credentialReads += 1;
				modelStoreReads += 1;
				return [providerModel];
			},
			getKnownModels: async () => [providerModel],
			getPluginProviderComposition: (candidateProviderId: string) => {
				const registration = pluginRuntime
					?.getProviderRegistrations(sessionId("session-1"))
					.find(
						({ providerId: registeredProviderId }) =>
							registeredProviderId === candidateProviderId
					);
				return registration === undefined
					? undefined
					: fromPartial<PluginProviderComposition>({ registration });
			},
		});
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		activeFakeSessionRun = {
			navigationRelease: deferred<void>(),
			navigationStarted: deferred<void>(),
			release,
			sendStarted,
		};
		const setupResult = await renderSessionView({
			configSettings: {
				agents: {
					[pinnedAgent]: {
						description: "Uses a Plugin Provider pin.",
						model: `${providerId}/${modelIdValue}`,
						role: "primary",
					},
				},
				default_agent: pinnedAgent,
			},
			height: 30,
			initialAgent: pinnedAgent,
			initialModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			initialTranscript: [],
			providerController,
			restoredSelection,
			width: 100,
		});

		try {
			await typePrompt(setupResult.setup, "submit the Plugin pin");
			await act(() => setupResult.setup.mockInput.pressEnter());
			await flushUi(setupResult.setup);
			expect(fakeRunInputs).toHaveLength(0);
			expect(availabilityReads).toBe(0);
			expect(credentialReads).toBe(0);
			expect(modelStoreReads).toBe(0);
			expect(
				setupResult.setup.captureCharFrame().replace(/\s+/gu, " ")
			).toContain("re-select it in Interactive Mode");
		} finally {
			release.resolve();
			setupResult.setup.renderer.destroy();
			await pluginRuntime?.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: workspace });
		}
	};

	test("rejects a built-in selection before availability when an unrelated Host Plugin snapshot is stale", async () => {
		let availabilityReads = 0;
		const providerModel: ProviderModel = {
			modelId: "gpt-5.6-luna",
			protocolId: "fake-provider",
			providerId: "openai",
		};
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => {
				availabilityReads += 1;
				return [providerModel];
			},
			getKnownModels: async () => [providerModel],
		});
		let snapshotChecks = 0;
		const { setup } = await renderSessionView({
			height: 30,
			initialModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			initialTranscript: [],
			providerController,
			assertPluginSnapshot: () => {
				snapshotChecks += 1;
				throw new Error("An unrelated Host Plugin registration is stale.");
			},
			width: 100,
		});

		try {
			await typePrompt(setup, "submit the built-in model");
			await act(() => setup.mockInput.pressEnter());
			await flushUi(setup);
			expect(snapshotChecks).toBe(1);
			expect(availabilityReads).toBe(0);
			expect(fakeRunInputs).toHaveLength(0);
			expect(setup.captureCharFrame().replace(/\s+/gu, " ")).toContain(
				"unrelated Host Plugin registration is stale"
			);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("uses an Agent pin only when its exact current Provider Model is available", async () => {
		const pinnedAgent = agentId("current-provider-model-agent");
		const pinnedModel: ProviderModel = {
			modelId: "gpt-5.6-luna",
			protocolId: "fake-provider",
			providerId: "openai",
		};
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		activeFakeSessionRun = {
			navigationRelease: deferred<void>(),
			navigationStarted: deferred<void>(),
			release,
			sendStarted,
		};
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => [pinnedModel],
			getKnownModels: async () => [pinnedModel],
		});
		const { setup } = await renderSessionView({
			configSettings: {
				agents: {
					[pinnedAgent]: {
						description: "Uses an exact current Provider Model.",
						model: "openai/gpt-5.6-luna",
						role: "primary",
					},
				},
				default_agent: pinnedAgent,
			},
			height: 30,
			initialAgent: pinnedAgent,
			initialModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			initialTranscript: [],
			providerController,
			width: 100,
		});

		try {
			await typePrompt(setup, "run the pinned model");
			await act(() => setup.mockInput.pressEnter());
			await sendStarted.promise;
			expect(fakeRunInputs[0]).toMatchObject({
				agent: pinnedAgent,
				model: {
					modelId: modelId("gpt-5.6-luna"),
					providerId: "openai",
				},
				resolvedAgent: {
					id: pinnedAgent,
					instructions: "",
				},
				selectionOverride: {
					model: {
						modelId: modelId("gpt-5.6-luna"),
						providerId: "openai",
					},
				},
			});
		} finally {
			release.resolve();
			setup.renderer.destroy();
		}
	});

	test("binds a trusted Plugin Agent pin before availability and submits the Host-valid owner", async () => {
		const workspace = process.cwd();
		const providerId = "trusted-session-view-provider";
		const providerModelId = "trusted-session-view-model";
		const pinnedAgent = agentId("trusted-session-view-agent");
		const owner = {
			pluginId: "trusted-session-view-plugin",
			sourceIdentity: "/trusted/session-view-provider.ts",
		};
		const sessionIdValue = sessionId("session-1");
		const providerModel: ProviderModel = {
			modelId: modelId(providerModelId),
			protocolId: "fake-provider",
			providerId,
		};
		const pluginRuntime = createProviderRuntime(providerId, [owner], workspace);
		setInteractiveRuntimeContext({ args: [], cwd: workspace, pluginRuntime });
		let availabilityReads = 0;
		const trustedRegistrations =
			pluginRuntime.getProviderRegistrations(sessionIdValue);
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => {
				availabilityReads += 1;
				return [providerModel];
			},
			getKnownModels: async () => [providerModel],
			getPluginProviderComposition: (candidateProviderId: string) => {
				const registration = trustedRegistrations.find(
					({ providerId: registeredProviderId }) =>
						registeredProviderId === candidateProviderId
				);
				return registration === undefined
					? undefined
					: fromPartial<PluginProviderComposition>({ registration });
			},
		});
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		activeFakeSessionRun = {
			navigationRelease: deferred<void>(),
			navigationStarted: deferred<void>(),
			release,
			sendStarted,
		};
		const { setup } = await renderSessionView({
			configSettings: {
				agents: {
					[pinnedAgent]: {
						description: "Uses a trusted Plugin Provider pin.",
						model: `${providerId}/${providerModelId}`,
						role: "primary",
					},
				},
				default_agent: pinnedAgent,
			},
			height: 30,
			initialAgent: pinnedAgent,
			initialModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			initialTranscript: [],
			providerController,
			width: 100,
		});

		try {
			await typePrompt(setup, "submit the trusted Plugin pin");
			await act(() => setup.mockInput.pressEnter());
			await sendStarted.promise;
			const submitted = fakeRunInputs[0];
			if (submitted === undefined) {
				throw new Error("The Session View did not submit its Agent pin.");
			}
			expect(submitted.model).toEqual({
				modelId: modelId(providerModelId),
				pluginProviderSource: owner,
				providerId,
			});
			expect(submitted.selectionOverride?.model).toEqual(submitted.model);
			expect(availabilityReads).toBe(1);

			const hostProviderCollection = fromPartial<
				ProviderCollection & {
					getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
				}
			>({ getPluginProviderRegistrations: () => trustedRegistrations });
			assertPluginProviderSelectionOwner(
				submitted.model,
				fromPartial<SessionCapabilities>({
					getPluginRuntime: () => pluginRuntime,
				}),
				hostProviderCollection,
				sessionIdValue
			);
		} finally {
			release.resolve();
			setup.renderer.destroy();
			await pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: workspace });
		}
	});

	for (const scenario of [
		{ name: "untrusted", owners: [] },
		{
			name: "ambiguous",
			owners: [
				{
					pluginId: "first-session-view-plugin",
					sourceIdentity: "/trusted/first-session-view-provider.ts",
				},
				{
					pluginId: "second-session-view-plugin",
					sourceIdentity: "/trusted/second-session-view-provider.ts",
				},
			],
		},
	]) {
		test(`rejects ${scenario.name} Plugin Agent pins before availability and credential reads`, async () => {
			await expectPinRejectedBeforeProviderAvailability({
				owners: scenario.owners,
			});
		});
	}

	test("does not rebind an ownerless restored Plugin Agent pin before availability", async () => {
		const providerId = "session-view-trusted-provider";
		const modelIdValue = "session-view-pinned-model";
		const pinnedAgent = agentId("session-view-plugin-pinned-agent");
		await expectPinRejectedBeforeProviderAvailability({
			owners: [
				{
					pluginId: "restored-session-view-plugin",
					sourceIdentity: "/trusted/restored-session-view-provider.ts",
				},
			],
			restoredSelection: {
				agent: pinnedAgent,
				model: {
					modelId: modelId(modelIdValue),
					providerId,
				},
				persistedAgent: pinnedAgent,
				thinkingLevel: undefined,
			},
		});
	});

	test("Plugin Thinking Level requests are limited to the selected model on the next Submission", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		const workspace = process.cwd();
		const pinnedAgentId = agentId("plugin-pinned-agent");
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("gpt-6-luna"),
			providerId: "openai",
		};
		const pinnedProviderModel: ProviderModel = {
			modelId: "gpt-5.6-luna",
			protocolId: "fake-provider",
			providerId: "openai",
		};
		const selectedProviderModel: ProviderModel = {
			modelId: selectedModel.modelId,
			protocolId: "fake-provider",
			providerId: selectedModel.providerId,
			reasoningEfforts: ["off", "low"],
		};
		const modelCandidates = [
			providerModelCandidate(pinnedProviderModel),
			providerModelCandidate(selectedProviderModel),
		];
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => [
				pinnedProviderModel,
				selectedProviderModel,
			],
			getAvailableProviderModelSelectionCandidates: async () => modelCandidates,
			getKnownModels: async () => [pinnedProviderModel, selectedProviderModel],
			getPluginProviderRegistrations: () => [],
			selectProviderModelSelectionCandidate: async <Result,>(
				candidate: ProviderModelSelectionCandidate,
				action: (
					model: ProviderModel,
					selection: ProviderModelSelection
				) => Result | Promise<Result>
			): Promise<Result> => await action(candidate.model, candidate.selection),
		});
		const configStore = createTestConfigStore();
		const pluginRuntime = await loadPlugins({
			bundledPlugins: [
				{
					id: "pinned_agent_plugin",
					factory: (api) => {
						const plugin = api.definePlugin({ id: "pinned_agent_plugin" });
						plugin.registerAgent({
							agent: {
								description: "Agent with a pinned model.",
								displayName: "Pinned Model Agent",
								id: pinnedAgentId,
								instructions: "Keep this Agent identity.",
								role: "all",
							},
							model: "openai/gpt-5.6-luna",
							thinkingLevel: "high",
							source: {
								path: "/plugins/pinned-agent.md",
								scope: "user",
							},
						});
						plugin.registerCommand({
							description: "Set model and thinking selection.",
							name: "select_model_and_thinking",
							handler: async () => {
								const selected = await api.setModel(selectedModel);
								api.setThinkingLevel("off");
								api.setThinkingLevel("high");
								return selected ? "selection updated" : "selection unavailable";
							},
						});
						plugin.registerCommand({
							description: "Use the Provider default Thinking Level.",
							name: "use_provider_default_thinking",
							handler: async () => {
								api.setThinkingLevel(undefined);
								return "selection cleared";
							},
						});
					},
				},
			],
			cliPaths: [],
			config: {
				configStore,
				cwd: workspace,
				homeRoot: os.homedir(),
				trustedProjectRoots: [],
				workspace,
			},
		});
		setInteractiveRuntimeContext({
			args: [],
			cwd: workspace,
			pluginRuntime,
		});
		activeFakeSessionRun = {
			navigationRelease,
			navigationStarted,
			release,
			sendStarted,
		};
		const router = buildRouter();
		await router.load();
		let registryIsReady = false;
		const setup = await testRenderWithClipboard(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{ configStore, homeRoot: os.homedir(), workspace }}
				>
					<ToastProvider>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider
									initialAgent={pinnedAgentId}
									initialModel={DEFAULT_PROVIDER_MODEL_SELECTION}
									initialThinkingLevel="high"
								>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionView
													host={createFakeSessionHost([], providerController)}
													initialTranscript={[]}
													sessionId={sessionId("session-selection")}
													sessionTitle="Use the Plugin selection"
												/>
												<AgentRegistryReadyProbe
													onReady={() => {
														registryIsReady = true;
													}}
												/>
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>,
			{ height: 30, width: 100 }
		);

		try {
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			let commandResult = "";
			await act(async () => {
				commandResult = await pluginRuntime.executeCommand(
					"pinned_agent_plugin",
					"select_model_and_thinking",
					{
						argument: "",
						sessionId: "session-selection",
						workspace,
					}
				);
			});
			expect(commandResult).toBe("selection updated");
			expect(fakeCacheWarmCancellations).toBe(1);
			await typePrompt(setup, "submit with the override");
			await act(async () => {
				setup.mockInput.pressEnter();
				await sendStarted.promise;
			});

			expect(fakeRunInputs.at(-1)).toMatchObject({
				agent: pinnedAgentId,
				model: selectedModel,
				selectionOverride: {
					model: selectedModel,
					thinking: { thinkingLevel: "off" },
				},
				thinkingLevel: "off",
			});

			const providerDefaultStarted = deferred<void>();
			await act(async () => {
				release.resolve();
				await Promise.resolve();
			});
			await flushUi(setup);
			if (activeFakeSessionRun === null) {
				throw new Error("No fake session run configured.");
			}
			activeFakeSessionRun.sendStarted = providerDefaultStarted;
			let defaultCommandResult = "";
			await act(async () => {
				defaultCommandResult = await pluginRuntime.executeCommand(
					"pinned_agent_plugin",
					"use_provider_default_thinking",
					{
						argument: "",
						sessionId: "session-selection",
						workspace,
					}
				);
			});
			expect(defaultCommandResult).toBe("selection cleared");
			await typePrompt(setup, "next");
			await act(async () => {
				setup.mockInput.pressEnter();
				await providerDefaultStarted.promise;
			});

			expect(fakeRunInputs.at(-1)).toMatchObject({
				agent: pinnedAgentId,
				model: selectedModel,
				selectionOverride: { model: selectedModel, thinking: {} },
			});
			expect(fakeRunInputs.at(-1)?.thinkingLevel).toBeUndefined();
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
			await pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: workspace });
		}
	});

	test("built-in Model picker cancels cache warming when the Provider Model changes", async () => {
		const selectedModel: ProviderModelSelection = {
			modelId: modelId("gpt-6-luna"),
			providerId: "openai",
		};
		const providerModel: ProviderModel = {
			modelId: selectedModel.modelId,
			protocolId: "fake-provider",
			providerId: selectedModel.providerId,
		};
		const candidate = providerModelCandidate(providerModel);
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => [providerModel],
			getAvailableProviderModelSelectionCandidates: async () => [candidate],
			getKnownModels: async () => [providerModel],
			selectProviderModelSelectionCandidate: async <Result,>(
				selected: ProviderModelSelectionCandidate,
				action: (
					model: ProviderModel,
					selection: ProviderModelSelection
				) => Result | Promise<Result>
			): Promise<Result> => await action(selected.model, selected.selection),
		});
		let observedModel: ProviderModelSelection =
			DEFAULT_PROVIDER_MODEL_SELECTION;
		const recordModel = (model: ProviderModelSelection): void => {
			observedModel = model;
		};
		const workspace = process.cwd();
		setInteractiveRuntimeContext({ args: [], cwd: workspace });
		let registryIsReady = false;
		const router = buildRouter();
		await router.load();
		const configStore = createTestConfigStore();
		const setup = await testRenderWithClipboard(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{ configStore, homeRoot: os.homedir(), workspace }}
				>
					<ToastProvider>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider
									initialModel={DEFAULT_PROVIDER_MODEL_SELECTION}
								>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionView
													host={createFakeSessionHost([], providerController)}
													initialTranscript={[]}
													sessionId={sessionId("model-picker-cancels-warming")}
													sessionTitle="Change the selected Provider Model"
												/>
												<PromptModelProbe onModel={recordModel} />
												<AgentRegistryReadyProbe
													onReady={() => {
														registryIsReady = true;
													}}
												/>
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>,
			{ height: 30, width: 100 }
		);

		try {
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			await typePrompt(setup, "/models");
			await setup.waitForFrame((frame) =>
				frame.includes("Select AI model for generation")
			);
			await act(() => setup.mockInput.pressTab());
			await setup.waitForFrame((frame) => frame.includes("Search models"));
			await act(async () => setup.mockInput.typeText("gpt-6-luna"));
			await setup.waitForFrame((frame) => frame.includes("gpt-6-luna"));
			await act(() => setup.mockInput.pressArrow("down"));
			await act(() => setup.mockInput.pressEnter());
			await flushUi(setup);
			await setup.waitForFrame((frame) => !frame.includes("Search models"));
			await flushUi(setup);
			expect(observedModel).toMatchObject(selectedModel);
			expect(fakeCacheWarmCancellations).toBe(1);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("built-in Agent picker cancels cache warming when the Agent changes", async () => {
		const workspace = process.cwd();
		const selectedAgent = agentId("cache-warming-agent");
		const providerModel: ProviderModel = {
			modelId: "gpt-5.6-luna",
			protocolId: "fake-provider",
			providerId: "openai",
		};
		const providerController = fromPartial<InteractiveProviderController>({
			getAvailableModels: async () => [providerModel],
			getKnownModels: async () => [providerModel],
		});
		let observedAgent: AgentId = agentId("build");
		const recordAgent = (agent: AgentId): void => {
			observedAgent = agent;
		};
		const recordModel = (_model: ProviderModelSelection): void => undefined;
		const pluginRuntime = createPluginRuntime(
			[
				{
					agents: [
						{
							agent: {
								description: "Agent that changes the prompt prefix.",
								displayName: "Cache Warming Agent",
								id: selectedAgent,
								instructions: "Use the cache-warming test persona.",
								role: "all",
							},
							model: "openai/gpt-5.6-luna",
							source: {
								path: "/plugins/cache-warming-agent.md",
								scope: "user",
							},
						},
					],
					commands: [],
					id: "cache-warming-agent-plugin",
					sourcePath: "/plugins/cache-warming-agent.ts",
					tools: [],
					workspace,
				},
			],
			[],
			[],
			[],
			createPluginPromptSelectionBridge()
		);
		setInteractiveRuntimeContext({ args: [], cwd: workspace, pluginRuntime });
		let registryIsReady = false;
		const router = buildRouter();
		await router.load();
		const configStore = createTestConfigStore();
		const setup = await testRenderWithClipboard(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{ configStore, homeRoot: os.homedir(), workspace }}
				>
					<ToastProvider>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider
									initialAgent={agentId("build")}
									initialModel={DEFAULT_PROVIDER_MODEL_SELECTION}
								>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionView
													host={createFakeSessionHost([], providerController)}
													initialTranscript={[]}
													sessionId={sessionId("agent-picker-cancels-warming")}
													sessionTitle="Change the selected Agent"
												/>
												<AgentRegistryReadyProbe
													onReady={() => {
														registryIsReady = true;
													}}
												/>
												<PromptModelProbe
													onAgent={recordAgent}
													onModel={recordModel}
												/>
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>,
			{ height: 30, width: 100 }
		);

		try {
			await setup.waitFor(() => registryIsReady);
			await flushUi(setup);
			await typePrompt(setup, "/agents");
			await setup.waitForFrame((frame) => frame.includes("Switch agents"));
			await act(() => setup.mockInput.pressTab());
			await setup.waitForFrame((frame) => frame.includes("Search agents"));
			await act(async () => setup.mockInput.typeText("Cache Warming Agent"));
			await setup.waitForFrame((frame) =>
				frame.includes("Cache Warming Agent")
			);
			await act(() => setup.mockInput.pressEnter());
			await setup.waitForFrame((frame) => !frame.includes("Search agents"));
			await setup.waitFor(() => observedAgent === selectedAgent);
			expect(fakeCacheWarmCancellations).toBe(1);
		} finally {
			setup.renderer.destroy();
			await pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: workspace });
		}
	});

	test("clears the composer before the active turn completes", async () => {
		const navigationRelease = deferred<void>();
		const navigationStarted = deferred<void>();
		const sendStarted = deferred<void>();
		const release = deferred<void>();
		let registryIsReady = false;
		activeFakeSessionRun = {
			navigationRelease,
			navigationStarted,
			release,
			sendStarted,
		};
		const router = buildRouter();
		await router.load();
		const configStore = createTestConfigStore();
		const workspace = process.cwd();
		const setup = await testRenderWithClipboard(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{ configStore, homeRoot: os.homedir(), workspace }}
				>
					<ToastProvider>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionView
													host={createFakeSessionHost([])}
													initialTranscript={[]}
													sessionId={sessionId("session-1")}
													sessionTitle="Send an entered prompt"
												/>
												<AgentRegistryReadyProbe
													onReady={() => {
														registryIsReady = true;
													}}
												/>
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>,
			{ height: 30, width: 100 }
		);

		try {
			await setup.waitFor(() => registryIsReady);
			await typePrompt(setup, "entered prompt");
			await flushUi(setup);
			setup.mockInput.pressEnter();
			const sendOutcome = await Promise.race([
				sendStarted.promise.then(() => "sent" as const),
				Bun.sleep(200).then(() => "timeout" as const),
			]);
			expect(sendOutcome).toBe("sent");
			await flushUi(setup);
			await typePrompt(setup, "next draft");
			await flushUi(setup);
			const frameWhileSendIsPending = setup.captureCharFrame();
			expect(frameWhileSendIsPending.match(/entered prompt/gu)).toHaveLength(1);
			expect(frameWhileSendIsPending).toContain("next draft");
			expect(frameWhileSendIsPending).not.toContain("entered promptnext draft");
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
});

type MutableConfigProviderControl = {
	replace: (config: ConfigRuntime) => void;
};

const MutableConfigProvider = ({
	children,
	control,
	initial,
}: {
	children: ReactNode;
	control: MutableConfigProviderControl;
	initial: ConfigRuntime;
}) => {
	const [config, setConfig] = useState(initial);
	control.replace = (next) => setConfig(next);
	return <ConfigProvider value={config}>{children}</ConfigProvider>;
};

/** The provider stack one SessionView test renders under. */
const renderSessionView = async ({
	height,
	initialTranscript,
	initialAgent,
	initialModel,
	configSettings,
	configStore: providedConfigStore,
	configProviderControl,
	liveTranscript = initialTranscript,
	onThinkingLevel,
	providerController,
	restoredSelection,
	assertPluginSnapshot,
	width,
}: {
	height: number;
	initialTranscript: SessionMessage[];
	initialAgent?: AgentId;
	initialModel?: ProviderModelSelection;
	configSettings?: Readonly<Record<string, unknown>>;
	configStore?: ConfigStore;
	configProviderControl?: MutableConfigProviderControl;
	liveTranscript?: SessionMessage[];
	onThinkingLevel?: (level: ThinkingLevel | undefined) => void;
	providerController?: InteractiveProviderController;
	restoredSelection?: ResolvedSessionSelection | null;
	assertPluginSnapshot?: () => void;
	width: number;
}) => {
	const router = buildRouter();
	await router.load();
	const configStore =
		providedConfigStore ?? createTestConfigStore(configSettings);
	const workspace = process.cwd();
	const configRuntime = { configStore, homeRoot: os.homedir(), workspace };
	let registryIsReady = false;
	const commandLayer = { isTop: false };
	const children = (
		<ToastProvider>
			<AgentRegistryProvider>
				<KeyboardLayerProvider>
					<PromptConfigProvider
						{...(initialAgent === undefined ? {} : { initialAgent })}
						{...(initialModel === undefined ? {} : { initialModel })}
					>
						<DialogProvider>
							<RouterContextProvider router={router}>
								<CommandControllerProvider>
									<SessionView
										host={createFakeSessionHost(
											liveTranscript,
											providerController,
											restoredSelection,
											assertPluginSnapshot
										)}
										initialTranscript={initialTranscript}
										sessionId={sessionId("session-1")}
										sessionTitle="Queue a prompt"
									/>
									{onThinkingLevel === undefined ? null : (
										<ThinkingLevelProbe onThinkingLevel={onThinkingLevel} />
									)}
									<AgentRegistryReadyProbe
										onReady={() => {
											registryIsReady = true;
										}}
									/>
									<KeyboardLayerProbe
										onLayer={(isCommandLayer) => {
											commandLayer.isTop = isCommandLayer;
										}}
									/>
								</CommandControllerProvider>
							</RouterContextProvider>
						</DialogProvider>
					</PromptConfigProvider>
				</KeyboardLayerProvider>
			</AgentRegistryProvider>
		</ToastProvider>
	);
	const configTree =
		configProviderControl === undefined ? (
			<ConfigProvider value={configRuntime}>{children}</ConfigProvider>
		) : (
			<MutableConfigProvider
				control={configProviderControl}
				initial={configRuntime}
			>
				{children}
			</MutableConfigProvider>
		);
	const setup = await testRenderWithClipboard(
		<ThemeProvider themeName={DEFAULT_THEME.name}>{configTree}</ThemeProvider>,
		{ height, width }
	);
	await setup.waitFor(() => registryIsReady);
	await flushUi(setup);
	return { commandLayer, setup };
};

test("updates the usage-bar context window after a global config reload", async () => {
	const workspace = process.cwd();
	let currentConfigStore = createTestConfigStore({
		contextWindowTokens: 272_000,
	});
	const transcript: SessionMessage[] = [
		userMessage("usage-user", "review context"),
		{
			id: sessionMessageId("usage-assistant"),
			metadata: {
				agent: agentId("build"),
				model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
				usage: { inputTokens: 7336, outputTokens: 0 },
				contextMeasurement: {
					epoch: "initial",
					stepId: "usage-step",
					usage: { inputTokens: 7336, outputTokens: 0 },
				},
			},
			parts: [{ text: "assistant response", type: "text" }],
			role: "assistant",
		},
	];
	const configProviderControl: MutableConfigProviderControl = {
		replace: () => undefined,
	};
	const { setup } = await renderSessionView({
		configProviderControl,
		configStore: currentConfigStore,
		height: 30,
		initialTranscript: transcript,
		liveTranscript: transcript,
		width: 100,
	});

	try {
		await setup.waitForFrame((frame) => frame.includes("2.7%/272k"));
		currentConfigStore = createTestConfigStore({
			contextWindowTokens: 100_000,
		});
		await act(async () => {
			configProviderControl.replace({
				configStore: currentConfigStore,
				homeRoot: os.homedir(),
				workspace,
			});
		});
		await setup.waitForFrame((frame) => frame.includes("7.3%/100k"));
	} finally {
		setup.renderer.destroy();
	}
});

test("refreshes reasoning metadata after model discovery changes on a stable controller", async () => {
	const model: ProviderModelSelection = {
		modelId: modelId("reasoning-model"),
		providerId: "plugin-provider",
	};
	let availabilityRevision = 0;
	let knownModelReads = 0;
	let knownModels: readonly ProviderModel[] = [];
	const availabilityListeners = new Set<() => void>();
	const providerController = fromPartial<InteractiveProviderController>({
		getAvailableModels: async () => knownModels,
		getAvailabilityRevision: () => availabilityRevision,
		getCompositionRevision: () => 0,
		getKnownModels: async () => {
			knownModelReads += 1;
			return knownModels;
		},
		subscribeAvailability: (listener: () => void) => {
			availabilityListeners.add(listener);
			return () => availabilityListeners.delete(listener);
		},
	});
	let observedThinkingLevel: ThinkingLevel | undefined;
	const { setup } = await renderSessionView({
		height: 30,
		initialModel: model,
		initialTranscript: [],
		onThinkingLevel: (level) => {
			observedThinkingLevel = level;
		},
		providerController,
		width: 100,
	});

	try {
		expect(observedThinkingLevel).toBeUndefined();
		await act(() => {
			knownModels = [
				{
					modelId: model.modelId,
					protocolId: "fixture",
					providerId: model.providerId,
					reasoningEfforts: ["high"],
				},
			];
			availabilityRevision += 1;
			for (const listener of [...availabilityListeners]) {
				listener();
			}
		});
		await setup.waitFor(() => knownModelReads >= 2);
		await flushUi(setup);
		await act(() => setup.mockInput.pressTab({ shift: true }));
		await flushUi(setup);

		expect(observedThinkingLevel).toBe("high");
	} finally {
		setup.renderer.destroy();
	}
});

test("renders unavailable attachment annotations over the unannotated Host transcript", async () => {
	const id = attachmentId("missing");
	const livePart: SessionFilePart = {
		attachmentId: id,
		mediaType: "image/png",
		type: "file",
		url: `attachment://${id}`,
	};
	const liveMessage: SessionMessage = {
		...userMessage("missing-attachment", ""),
		parts: [livePart],
	};
	const displayMessage: SessionMessage = {
		...liveMessage,
		parts: [{ ...livePart, displayAvailability: "missing" }],
	};
	const { setup } = await renderSessionView({
		height: 20,
		initialTranscript: [displayMessage],
		liveTranscript: [liveMessage],
		width: 100,
	});
	try {
		expect(setup.captureCharFrame()).toContain("Unavailable");
	} finally {
		setup.renderer.destroy();
	}
});

/** Renders the view with one Agent Turn already running. */
const renderBusySessionView = async () => {
	const release = deferred<void>();
	const sendStarted = deferred<void>();
	activeFakeSessionRun = {
		navigationRelease: deferred<void>(),
		navigationStarted: deferred<void>(),
		release,
		sendStarted,
	};
	const { commandLayer, setup } = await renderSessionView({
		height: 20,
		initialTranscript: [],
		width: 100,
	});
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await setup.mockInput.typeText("first prompt");
		await flushUi(setup);
		if (frameIncludes(setup, "first prompt")) {
			break;
		}
	}
	setup.mockInput.pressEnter();
	await sendStarted.promise;
	await flushUi(setup);
	return { commandLayer, release, setup };
};

describe("SessionView waiting messages", () => {
	/**
	 * Types into the composer until the composition is really there. The
	 * composer reset a previous submit triggered reaches the textarea through a
	 * passive effect, and this harness can deliver keystrokes before that
	 * effect runs; a real user cannot type inside that window.
	 */
	const typePrompt = async (setup: TestRendererSetup, text: string) => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await setup.mockInput.typeText(text);
			await flushUi(setup);
			if (frameIncludes(setup, text)) {
				return;
			}
		}
		throw new Error(`The composer never held "${text}".`);
	};

	/** Types one submission into the composer and sends it. */
	const submit = async (setup: TestRendererSetup, text: string) => {
		await typePrompt(setup, text);
		setup.mockInput.pressEnter();
	};

	/**
	 * Lets the asynchronous work behind a keypress land before a condition is
	 * checked, so the wait is about the condition rather than about patience.
	 */
	const waitFor = async (
		setup: TestRendererSetup,
		condition: () => boolean
	) => {
		await flushUi(setup);
		await setup.waitFor(condition);
	};

	test("holds a prompt entered while the turn is running", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");

			// A busy composer admits an independent queued prompt; steering is
			// requested only by another Enter after the composer has cleared.
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(fakeWaitingTexts).toEqual(["second prompt"]);
			expect(frame).toMatch(WAITING_COUNT_PATTERN);
			expect(frame).toContain("▸ queued");
			expect(frame).toMatch(LANE_ROW("queued", "second prompt"));
			expect(frame).toContain("Alt+Up");
			expect(frame.match(/second prompt/gu)).toHaveLength(1);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
	test("restores turn-failed queue submissions to the composer in order", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			const texts = [
				"failed prompt one",
				"failed prompt two",
				"failed prompt three",
				"failed prompt four",
			];
			act(() => {
				for (const [index, text] of texts.entries()) {
					emitFakeSubmissionEvent(
						fromPartial<SessionSubmissionEvent>({
							composition: { files: [], text },
							kind: "recalled",
							messageId: sessionMessageId(`failed-${index}`),
							reason: "turn-failed",
							submissionId: `failed-submission-${index}`,
						})
					);
				}
			});
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			let previousPosition = -1;
			for (const text of texts) {
				const position = frame.indexOf(text);
				expect(position).toBeGreaterThan(previousPosition);
				expect(frame.split(text)).toHaveLength(2);
				previousPosition = position;
			}
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
		} finally {
			await act(async () => {
				release.resolve();
				await flushUi(setup);
				setup.renderer.destroy();
			});
		}
	});

	test("shows a failed Steering Submission's reason to the user", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			const reason = "Attachment unavailable; resend without it.";
			act(() => {
				emitFakeSubmissionEvent(
					fromPartial<SessionSubmissionEvent>({
						kind: "failed",
						messageId: sessionMessageId("failed-steering"),
						reason,
						submissionId: "failed-steering-submission",
					})
				);
			});
			await flushUi(setup);

			expect(setup.captureCharFrame()).toContain(reason);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls the queue into the composer on Alt+Up", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);

			setup.mockInput.pressArrow("up", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			const frame = setup.captureCharFrame();
			expect(frame.match(/second prompt/gu)).toHaveLength(1);
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
			expect(frame).not.toContain("Alt+Up");
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls only the submission that runs next on Shift+Up", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "first waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await submit(setup, "second waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// The submission that would have run next is back in the composer,
			// and the one behind it keeps waiting.
			expect(fakeWaitingTexts).toEqual(["second waiting"]);
			expect(setup.captureCharFrame()).toContain("1 waiting");

			// Submitting the withdrawn text again joins the tail of the queue,
			// so the submission that stayed keeps its place.
			setup.mockInput.pressEnter();
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			expect(fakeWaitingTexts).toEqual(["second waiting", "first waiting"]);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("empties the queue one submission per Shift+Up, below the draft", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "first waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await submit(setup, "second waiting");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			await typePrompt(setup, "my own draft");

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 2);
			await flushUi(setup);
			await flushUi(setup);

			// Recalling one at a time reaches the whole queue, and the strip goes
			// with it.
			expect(fakeWaitingTexts).toEqual([]);
			const frame = setup.captureCharFrame();
			expect(frame).not.toMatch(WAITING_COUNT_PATTERN);
			expect(frame).not.toContain("Shift+Up");

			// The draft stays on top and each recall lands below the one before
			// it, so the composer reads in the order the queue would have run.
			const draftAt = frame.indexOf("my own draft");
			const firstAt = frame.indexOf("first waiting");
			const secondAt = frame.indexOf("second waiting");
			expect(draftAt).toBeGreaterThanOrEqual(0);
			expect(firstAt).toBeGreaterThan(draftAt);
			expect(secondAt).toBeGreaterThan(firstAt);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("restores a recalled composition's attachments and pasted text", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			const file: SessionFilePart = {
				filename: "clipboard.png",
				mediaType: "image/png",
				type: "file",
				url: "data:image/png;base64,AAAA",
			};
			const composition: SessionSubmissionComposition = {
				fileTokens: [{ start: 0, token: "[Image 1]" }],
				files: [file],
				pastedText: [
					{
						text: "pasted line one\npasted line two",
						token: "[Pasted ~20 lines]",
					},
				],
				text: "[Image 1] [Pasted ~20 lines] explain these",
			};
			fakeRecalledPayload = [
				fromPartial<SessionQueuedSubmission>({
					id: queuedSubmissionId("queued-recall"),
					input: { composition, files: [file] },
				}),
			];

			setup.mockInput.pressArrow("up", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// Both markers are back in the composer, so nothing of the recalled
			// composition was lost on the way.
			const recalledFrame = setup.captureCharFrame();
			expect(recalledFrame).toContain("[Image 1]");
			expect(recalledFrame).toContain("[Pasted ~20 lines]");
			expect(recalledFrame).toContain("explain these");

			// The turn ends, and sending the restored composition carries the same
			// attachments, pasted text, and visible text it was composed with.
			const sentBefore = fakeRunCompositions.length;
			release.resolve();
			await flushUi(setup);
			await flushUi(setup);
			setup.mockInput.pressEnter();
			await waitFor(setup, () => fakeRunCompositions.length === sentBefore + 1);
			expect(fakeRunCompositions.at(-1)).toEqual(composition);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("recalls the queue with the fallback binding", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);

			// A terminal that cannot deliver Alt+Arrow still reaches Recall.
			setup.mockInput.pressKey("z", { meta: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("Alt+Up recalls only uncommitted queue entries", async () => {
		const { release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "steer me");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			setup.mockInput.pressEnter();
			await flushUi(setup);
			await submit(setup, "later prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 2);
			await flushUi(setup);
			await flushUi(setup);

			// Steered messages remain committed in the session, but only
			// uncommitted work appears in the waiting strip.
			const frame = setup.captureCharFrame();
			expect(frame).toContain("1 waiting");
			expect(frame).not.toContain("steer me");
			expect(frame).toMatch(LANE_ROW("queued", "later prompt"));
			expect(frame).toContain("▸ queued");

			setup.mockInput.pressArrow("up", { shift: true });
			await waitFor(setup, () => fakeSessionRecalls === 1);
			await flushUi(setup);
			await flushUi(setup);

			// Recall withdraws the uncommitted prompt; committed steering stays
			// out of the waiting strip.
			expect(fakeWaitingTexts).toEqual(["steer me"]);
			const afterRecall = setup.captureCharFrame();
			expect(afterRecall).not.toMatch(WAITING_COUNT_PATTERN);
			expect(afterRecall).not.toContain("steer me");
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});

	test("empty Enter removes one committed Submission from the waiting queue", async () => {
		fakeQueuedSeed = [
			fromPartial<SessionQueuedSubmission>({
				id: queuedSubmissionId("queued-first"),
				input: { composition: { files: [], text: "first queued" } },
			}),
			fromPartial<SessionQueuedSubmission>({
				id: queuedSubmissionId("queued-later-1"),
				input: { composition: { files: [], text: "later queued 1" } },
			}),
			fromPartial<SessionQueuedSubmission>({
				id: queuedSubmissionId("queued-later-2"),
				input: { composition: { files: [], text: "later queued 2" } },
			}),
			fromPartial<SessionQueuedSubmission>({
				id: queuedSubmissionId("queued-later-3"),
				input: { composition: { files: [], text: "later queued 3" } },
			}),
		];
		const { release, setup } = await renderBusySessionView();
		try {
			setup.mockInput.pressEnter();
			await flushUi(setup);

			let frame = setup.captureCharFrame();
			expect(frame).toContain("3 waiting");
			expect(frame).not.toContain("first queued");
			expect(frame).not.toContain("steering");
			expect(frame).toMatch(LANE_ROW("queued", "later queued 1"));
			expect(frame).toMatch(LANE_ROW("queued", "later queued 2"));
			expect(frame).toContain("▸ queued");
			expect(frame).toMatch(LANE_ROW("queued", "later queued 3"));

			await typePrompt(setup, "ordinary input");
			setup.mockInput.pressEnter();
			await flushUi(setup);

			frame = setup.captureCharFrame();
			expect(frame).toContain("4 waiting");
			expect(frame).not.toContain("first queued");
			expect(frame).toMatch(LANE_ROW("queued", "ordinary input"));
			expect(frame).toMatch(LANE_ROW("queued", "later queued 1"));
			expect(frame).toMatch(LANE_ROW("queued", "later queued 2"));
			expect(frame).toMatch(LANE_ROW("queued", "later queued 3"));
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
	test("leaves the queue alone while an overlay is open", async () => {
		const { commandLayer, release, setup } = await renderBusySessionView();
		try {
			await submit(setup, "second prompt");
			await waitFor(setup, () => fakeWaitingTexts.length === 1);
			await setup.mockInput.typeText("/");
			// The overlay renders before its keyboard layer is pushed, so the
			// test waits for both before pressing a key.
			await flushUi(setup);
			await flushUi(setup);
			expect(setup.captureCharFrame()).toContain("Start a new session");
			await waitFor(setup, () => commandLayer.isTop);

			setup.mockInput.pressArrow("up", { meta: true });
			await flushUi(setup);
			// The command overlay owns the keyboard: Alt+Up recalls nothing, and
			// the queued submission stays queued.
			expect(fakeSessionRecalls).toBe(0);
			expect(fakeWaitingTexts).toEqual(["second prompt"]);
		} finally {
			release.resolve();
			await flushUi(setup);
			setup.renderer.destroy();
		}
	});
});
