import * as path from "node:path";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
	PluginFactory,
	PluginSessionContext,
	PluginUICustomComponent,
	PluginUICustomFactory,
	PluginUICustomPresentationHandle,
	SessionSdkEvent,
} from "@wincode/coding-agent";
import { useEffect, useRef } from "react";

const TERMINAL_AGENT_TURN_EVENTS: ReadonlySet<SessionSdkEvent["type"]> =
	new Set([
		"agent-turn-completed",
		"agent-turn-failed",
		"agent-turn-cancelled",
		"agent-turn-interrupted",
	]);

const observeSessionTurn = (
	subscribe: (listener: (event: SessionSdkEvent) => void) => () => void,
	workspace: string
) => {
	const terminal = Promise.withResolvers<SessionSdkEvent>();
	const stopObserving = subscribe((event) => {
		if (event.type === "text-delta") {
			void Bun.write(
				path.join(workspace, ".smoke-custom-editor-turn-progress"),
				"advanced"
			);
		}
		if (TERMINAL_AGENT_TURN_EVENTS.has(event.type)) {
			terminal.resolve(event);
		}
	});
	return { stopObserving, terminal: terminal.promise };
};

const waitForSessionTurn = async (
	prompt: () => Promise<Readonly<{ rejected: boolean; reason?: string }>>,
	terminal: Promise<SessionSdkEvent>,
	workspace: string
): Promise<void> => {
	try {
		const admission = await prompt();
		if (admission.rejected) {
			await Bun.write(
				path.join(workspace, ".smoke-custom-editor-turn-terminal"),
				`rejected:${admission.reason ?? "unknown"}`
			);
			return;
		}
		const outcome = await terminal;
		await Bun.write(
			path.join(workspace, ".smoke-custom-editor-turn-terminal"),
			outcome.type
		);
	} catch (error) {
		await Bun.write(
			path.join(workspace, ".smoke-custom-editor-turn-terminal"),
			`failed:${error instanceof Error ? error.message : String(error)}`
		);
	}
};

const handleSmokeOverlayKey = (
	key: KeyEvent,
	presentationHandle: PluginUICustomPresentationHandle,
	input: InputRenderable | null,
	done: (value: string) => void
): void => {
	if (key.name === "escape" || (key.ctrl && key.name === "c")) {
		key.preventDefault();
		return;
	}
	if (key.name === "f") {
		key.preventDefault();
		if (presentationHandle.isFocused()) {
			presentationHandle.unfocus();
		} else {
			presentationHandle.focus();
		}
		return;
	}
	if (key.name === "h") {
		key.preventDefault();
		presentationHandle.setHidden(!presentationHandle.isHidden());
		return;
	}
	if (
		presentationHandle.isFocused() &&
		(key.name === "enter" || key.name === "return")
	) {
		key.preventDefault();
		done(input?.value ?? "smoke editor dismissed");
	}
};

const createSmokeEditorFactory =
	(
		sessionSdk: NonNullable<PluginSessionContext["sessionSdk"]>,
		sessionId: string,
		workspace: string
	): PluginUICustomFactory<string> =>
	async () => {
		const component: PluginUICustomComponent<string> = ({
			done,
			height,
			presentation,
			presentationHandle,
			theme,
			width,
		}) => {
			const input = useRef<InputRenderable>(null);
			const focused = presentationHandle.isFocused();
			const hidden = presentationHandle.isHidden();
			const bounds = presentationHandle.getBounds();
			useEffect(() => {
				void Bun.write(
					path.join(workspace, ".smoke-custom-overlay-state"),
					JSON.stringify({
						bounds,
						focused,
						height,
						hidden,
						presentation,
						width,
					})
				);
			}, [bounds, focused, height, hidden, presentation, width]);
			useEffect(() => {
				let mounted = true;
				let disposeHandle: (() => Promise<void>) | undefined;
				let stopObserving: (() => void) | undefined;
				const runAgentTurn = async (): Promise<void> => {
					await Bun.write(
						path.join(workspace, ".smoke-custom-editor-mounted"),
						"mounted"
					);
					const openedHandle = await sessionSdk.openSession(sessionId, {
						autoContinue: false,
						view: false,
					});
					if (!mounted) {
						await openedHandle.dispose();
						return;
					}
					disposeHandle = () => openedHandle.dispose();
					const observation = observeSessionTurn(
						(listener) => openedHandle.onEvent(listener),
						workspace
					);
					stopObserving = observation.stopObserving;
					await waitForSessionTurn(
						() => openedHandle.prompt({ text: "terminal smoke stream" }),
						observation.terminal,
						workspace
					);
				};
				void runAgentTurn();
				return () => {
					mounted = false;
					stopObserving?.();
					if (disposeHandle !== undefined) {
						void disposeHandle();
					}
				};
			}, []);
			useKeyboard((key) =>
				handleSmokeOverlayKey(key, presentationHandle, input.current, done)
			);
			return (
				<box flexDirection="column" gap={1} paddingX={1} width="100%">
					<text fg={theme.colors.text}>Smoke custom overlay</text>
					<text fg={theme.colors.textMuted}>
						{`Focus: ${focused} · Hidden: ${hidden} · Bounds: ${bounds.left},${bounds.top} ${bounds.width}x${bounds.height} · Content: ${width}x${height}`}
					</text>
					<text fg={theme.colors.textMuted}>
						F toggles focus, H toggles visibility; the fake Agent Turn runs
						while open.
					</text>
					<input
						focused={focused}
						onContentChange={() => undefined}
						placeholder="Write a reply"
						ref={input}
					/>
				</box>
			);
		};
		return component;
	};

const interactivePluginUISmoke: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "interactive_plugin_ui_smoke" });
	let sessionSdk: PluginSessionContext["sessionSdk"];
	plugin.onSessionStart(({ sessionSdk: operations }) => {
		sessionSdk = operations;
	});
	plugin.registerCommand({
		description: "Show custom overlay while a fake Agent Turn completes.",
		name: "smoke-editor-turn",
		handler: async ({ sessionId, ui, workspace }) => {
			await Bun.write(
				path.join(workspace, ".smoke-editor-command-started"),
				"started"
			);
			await Bun.write(
				path.join(workspace, ".smoke-editor-command-context"),
				`${sessionId === undefined ? "missing-session" : "session"}:${sessionSdk === undefined ? "missing-sdk" : "sdk"}`
			);
			if (sessionId === undefined || sessionSdk === undefined) {
				throw new Error("The Interactive Mode Session SDK is unavailable.");
			}
			const result = await ui.custom(
				createSmokeEditorFactory(sessionSdk, sessionId, workspace),
				{
					presentation: "overlay",
					title: "Smoke custom overlay during Agent progress",
				}
			);
			await Bun.write(
				path.join(workspace, ".smoke-editor-command-result"),
				result ?? "undefined"
			);
			return result ?? "Smoke custom editor dismissed.";
		},
	});
};

export default interactivePluginUISmoke;
