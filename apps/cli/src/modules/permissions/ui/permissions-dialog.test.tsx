import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useEffect } from "react";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	createPermissionService,
	type PermissionService,
} from "../permission-service";
import { PermissionServiceProvider } from "../permission-service-provider";
import { PermissionsDialogContent } from "./permissions-dialog";

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const renderPermissionsDialog = async (service: PermissionService) => {
	// The content's default dialog layer id is "dialog"; push it so keyboard
	// handlers treat this dialog as the top layer.
	function Harness() {
		const { push } = useKeyboardLayer();
		useEffect(() => {
			push("dialog");
		}, [push]);
		return <PermissionsDialogContent />;
	}
	const setup = await testRender(
		<ThemeProvider>
			<KeyboardLayerProvider>
				<DialogProvider>
					<PermissionServiceProvider service={service}>
						<Harness />
					</PermissionServiceProvider>
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 40, width: 120 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return setup;
};

test("lists temporary grants by exact action and resource", async () => {
	const service = createPermissionService();
	service.grant("edit", "src/app.ts");
	service.grant("read", ".env");
	const setup = await renderPermissionsDialog(service);

	const frame = setup.captureCharFrame();
	expect(frame).toContain("edit");
	expect(frame).toContain("src/app.ts");
	expect(frame).toContain("read");
	expect(frame).toContain(".env");
	setup.renderer.destroy();
});

test("shows an empty state when there are no grants", async () => {
	const setup = await renderPermissionsDialog(createPermissionService());
	expect(setup.captureCharFrame()).toContain("No temporary grants");
	setup.renderer.destroy();
});

test("enter on the top row toggles auto approval and reflects it", async () => {
	const service = createPermissionService();
	const setup = await renderPermissionsDialog(service);
	expect(setup.captureCharFrame()).toContain("Auto approval: off");

	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(service.isAutoApproval()).toBe(true);
	expect(setup.captureCharFrame()).toContain("Auto approval: on");
	setup.renderer.destroy();
});

test("selecting a grant row and pressing enter revokes it", async () => {
	const service = createPermissionService();
	service.grant("edit", "src/app.ts");
	const setup = await renderPermissionsDialog(service);

	// Row 0 is the auto toggle; the first grant is row 1.
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(service.isGranted("edit", "src/app.ts")).toBe(false);
	expect(service.listGrants()).toEqual([]);
	const frame = setup.captureCharFrame();
	expect(frame).toContain("No temporary grants");
	setup.renderer.destroy();
});

test("revoking one grant leaves the others intact", async () => {
	const service = createPermissionService();
	service.grant("edit", "a.ts");
	service.grant("edit", "b.ts");
	const setup = await renderPermissionsDialog(service);

	// Select and revoke the first grant row (sorted: a.ts before b.ts).
	setup.mockInput.pressArrow("down");
	setup.mockInput.pressEnter();
	await flushUi(setup);

	expect(service.listGrants()).toEqual([{ action: "edit", resource: "b.ts" }]);
	setup.renderer.destroy();
});
