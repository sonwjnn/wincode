import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	AgentDiagnosticsFooter,
	getAgentUnavailableReason,
} from "./agents-dialog";

test("explains when a model-pinned Agent needs a Connection", () => {
	const agent = {
		description: "Reviews code",
		displayName: "Reviewer",
		id: "reviewer",
		instructions: "",
		isAvailable: false,
		model: { providerId: "openai" },
		role: "primary",
		unavailableReason: "Connect openai to use this Agent",
		visibleCodingTools: [],
	} as const;
	expect(getAgentUnavailableReason(agent, new Set(["wincode"]))).toBe(
		"Connect openai"
	);
	expect(getAgentUnavailableReason(agent, new Set(["openai"]))).toBeUndefined();
});

test("keeps source-attributed Agent diagnostics visible", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<AgentDiagnosticsFooter
				diagnostics={[
					{
						code: "invalid-agent",
						configPath: ["agents", "helper", "role"],
						message: "Expected a valid role",
						origin: {
							path: "/workspace/wincode.json",
							scope: "project",
						},
						severity: "error",
					},
				]}
			/>
		</ThemeProvider>,
		{ height: 10, width: 100 }
	);
	await setup.renderOnce();

	const frame = setup.captureCharFrame();
	expect(frame).toContain("Agent configuration diagnostics");
	expect(frame).toContain("project /workspace/wincode.json");
	expect(frame).toContain("agents.helper.role");
	setup.renderer.destroy();
});
