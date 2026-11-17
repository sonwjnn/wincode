import * as path from "node:path";
import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
	PluginFactory,
	PluginSessionContext,
	PluginUICustomComponent,
	PluginUICustomFactory,
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

const createSmokeEditorFactory =
	(
		sessionSdk: NonNullable<PluginSessionContext["sessionSdk"]>,
		sessionId: string,
		workspace: string
	): PluginUICustomFactory<string> =>
	async () => {
		const component: PluginUICustomComponent<string> = ({ done, theme }) => {
			const input = useRef<InputRenderable>(null);
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
			useKeyboard((key) => {
				if (key.name === "enter" || key.name === "return") {
					key.preventDefault();
					done(input.current?.value ?? "smoke editor dismissed");
				}
			});
			return (
				<box flexDirection="column" gap={1} paddingX={1} width="100%">
					<text fg={theme.colors.text}>Smoke custom editor</text>
					<text fg={theme.colors.textMuted}>
						The fake Agent Turn starts after this editor mounts.
					</text>
					<input
						focused
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
		description: "Show custom editor while a fake Agent Turn completes.",
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
				{ title: "Smoke custom editor during Agent progress" }
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
