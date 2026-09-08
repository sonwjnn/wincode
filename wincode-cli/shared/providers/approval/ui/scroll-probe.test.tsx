import { test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	ApprovalPanelsProvider,
	useApprovalPanels,
} from "../approval-panels-provider";
import type { ToolApprovalActions, ToolApprovalRequest } from "../types";
import { PendingApprovalDock } from "./tool-approval-panel";

const longDescription = Array.from(
	{ length: 30 },
	(_, index) =>
		`Line ${index + 1}: a rather long description segment that wraps across the terminal width.`
).join(" ");

const request: ToolApprovalRequest = {
	description: longDescription,
	identity: [
		{ label: "tool", value: "read" },
		{ label: "resource", value: ".env" },
	],
	input: { path: ".env" },
	toolCallId: "call-1",
};
const actions: ToolApprovalActions = {
	abort: () => undefined,
	allow: () => undefined,
	reject: () => undefined,
	cancel: () => undefined,
};

function Register() {
	const { add } = useApprovalPanels();
	useEffect(() => {
		add(request, actions);
	}, [add]);
	return null;
}

test("probe long content wrapping in the dock", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<ApprovalPanelsProvider>
					<Register />
					<PendingApprovalDock />
				</ApprovalPanelsProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 20, width: 100 }
	);
	await setup.renderOnce();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
	console.log(
		setup
			.captureCharFrame()
			.split("\n")
			.map((row, index) => `${String(index).padStart(2, "0")}|${row}|`)
			.join("\n")
	);
	setup.renderer.destroy();
});
