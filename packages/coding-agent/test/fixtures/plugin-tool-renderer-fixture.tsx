import type {
	PluginFactory,
	PluginToolCallRenderer,
	PluginToolResultRenderer,
} from "@wincode/coding-agent";
import { useEffect } from "react";
import { z } from "zod";

export type PluginToolRendererFixtureState = {
	callMounts: number;
	callStates: string[];
	executionCount: number;
	resultMounts: number;
	resultStates: boolean[];
	callUnmounts: number;
	resultUnmounts: number;
};

export const pluginToolRendererFixtureState: PluginToolRendererFixtureState = {
	callMounts: 0,
	callStates: [],
	executionCount: 0,
	resultMounts: 0,
	resultStates: [],
	callUnmounts: 0,
	resultUnmounts: 0,
};

export const resetPluginToolRendererFixtureState = (): void => {
	pluginToolRendererFixtureState.callMounts = 0;
	pluginToolRendererFixtureState.callStates = [];
	pluginToolRendererFixtureState.executionCount = 0;
	pluginToolRendererFixtureState.resultMounts = 0;
	pluginToolRendererFixtureState.resultStates = [];
	pluginToolRendererFixtureState.callUnmounts = 0;
	pluginToolRendererFixtureState.resultUnmounts = 0;
};

type FixtureInput = Readonly<{
	failCallPresentation?: boolean;
	failResultPresentation?: boolean;
	mutateCall?: boolean;
	mutateResult?: boolean;
	query: string;
}>;

const CallRenderer: PluginToolCallRenderer = ({
	call,
	height,
	theme,
	width,
}) => {
	useEffect(() => {
		pluginToolRendererFixtureState.callMounts += 1;
		return () => {
			pluginToolRendererFixtureState.callUnmounts += 1;
		};
	}, []);
	useEffect(() => {
		pluginToolRendererFixtureState.callStates.push(call.state);
	}, [call.state]);
	const input = call.input as FixtureInput | undefined;
	if (input?.failCallPresentation) {
		throw new Error("Fixture call renderer failed.");
	}
	if (
		input?.mutateCall === true &&
		call.input !== null &&
		typeof call.input === "object"
	) {
		Object.assign(call.input, { query: "mutated by renderer" });
	}
	return (
		<text fg={theme.colors.tool}>
			{`fixture call ${call.state} ${theme.name} ${width}x${height}`}
		</text>
	);
};

const ResultRenderer: PluginToolResultRenderer = ({
	call,
	expanded,
	height,
	result,
	theme,
	width,
}) => {
	useEffect(() => {
		pluginToolRendererFixtureState.resultMounts += 1;
		return () => {
			pluginToolRendererFixtureState.resultUnmounts += 1;
		};
	}, []);
	useEffect(() => {
		pluginToolRendererFixtureState.resultStates.push(expanded);
	}, [expanded]);
	if (
		result.type === "success" &&
		(result.output as { failResultPresentation?: boolean })
			?.failResultPresentation
	) {
		throw new Error("Fixture result renderer failed.");
	}
	if (
		result.type === "success" &&
		result.output !== null &&
		typeof result.output === "object" &&
		"mutatePresentation" in result.output &&
		result.output.mutatePresentation === true
	) {
		Object.assign(result.output, { answer: "mutated by renderer" });
	}
	const answer =
		result.type === "success"
			? (result.output as { answer?: string }).answer
			: result.errorText;
	return (
		<box paddingX={call.toolName.endsWith("owned_shell") ? 3 : 0} width="100%">
			<text fg={theme.colors.primary}>
				{`fixture result ${answer ?? "?"} ${expanded ? "expanded" : "collapsed"} ${theme.name} ${width}x${height}`}
			</text>
		</box>
	);
};

const OwnedShellCallRenderer: PluginToolCallRenderer = ({ call, theme }) => (
	<box paddingX={3} width="100%">
		<text fg={theme.colors.tool}>{`owned call ${call.state}`}</text>
	</box>
);

const SessionCallRenderer: PluginToolCallRenderer = ({ call, theme }) => (
	<text fg={theme.colors.tool}>{`session-scoped call ${call.state}`}</text>
);

const TurnCallRenderer: PluginToolCallRenderer = ({ call, theme }) => (
	<text fg={theme.colors.tool}>{`turn-scoped call ${call.state}`}</text>
);

const pluginToolRendererFixture: PluginFactory = (api) => {
	let registerTurnScopedTool = true;
	const plugin = api.definePlugin({ id: "tool_renderer_fixture" });
	plugin.onSessionStart((_context, registration) => {
		registration.registerTool({
			name: "session_scoped",
			description: "Register a renderer for one Session.",
			inputSchema: z.object({ query: z.string() }),
			renderCall: SessionCallRenderer,
			handler: async ({ query }) => ({
				output: { answer: `session result for ${query}` },
				type: "success",
			}),
		});
	});
	plugin.onBeforeAgentTurn((_context, registration) => {
		if (!registerTurnScopedTool) {
			return;
		}
		registerTurnScopedTool = false;
		registration.registerTool({
			name: "turn_scoped",
			description: "Register a renderer for one Agent Turn.",
			inputSchema: z.object({ query: z.string() }),
			renderCall: TurnCallRenderer,
			handler: async ({ query }) => ({
				output: { answer: `turn result for ${query}` },
				type: "success",
			}),
		});
	});
	plugin.registerTool({
		name: "lookup",
		description: "Look up a fixture answer.",
		inputSchema: z.object({
			failCallPresentation: z.boolean().optional(),
			failResultPresentation: z.boolean().optional(),
			mutateResult: z.boolean().optional(),
			query: z.string(),
		}),
		renderCall: CallRenderer,
		renderResult: ResultRenderer,
		handler: async (input) => {
			pluginToolRendererFixtureState.executionCount += 1;
			return {
				output: {
					answer: `result for ${input.query}`,
					failResultPresentation: input.failResultPresentation ?? false,
					mutatePresentation: input.mutateResult ?? false,
				},
				type: "success",
			};
		},
	});
	plugin.registerTool({
		name: "owned_shell",
		description: "Render a fixture row with Plugin-owned shell.",
		inputSchema: z.object({ query: z.string() }),
		renderCall: OwnedShellCallRenderer,
		ownsRowShell: true,
		handler: async ({ query }) => ({
			output: { answer: `owned result for ${query}` },
			type: "success",
		}),
	});
};

export default pluginToolRendererFixture;
