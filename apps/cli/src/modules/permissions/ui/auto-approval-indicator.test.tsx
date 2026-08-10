import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import {
	createPermissionService,
	type PermissionService,
} from "../permission-service";
import { PermissionServiceProvider } from "../permission-service-provider";
import { AutoApprovalIndicator } from "./auto-approval-indicator";

const flushUi = async (
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await setup.renderOnce();
};

const renderIndicator = async (service: PermissionService) => {
	const setup = await testRender(
		<ThemeProvider>
			<PermissionServiceProvider service={service}>
				<AutoApprovalIndicator />
			</PermissionServiceProvider>
		</ThemeProvider>,
		{ height: 4, width: 40 }
	);
	await setup.renderOnce();
	await flushUi(setup);
	return setup;
};

test("is hidden while auto approval is off", async () => {
	const setup = await renderIndicator(createPermissionService());
	expect(setup.captureCharFrame()).not.toContain("auto");
	setup.renderer.destroy();
});

test("shows the auto indicator while auto approval is enabled", async () => {
	const setup = await renderIndicator(
		createPermissionService({ autoApproval: true })
	);
	expect(setup.captureCharFrame()).toContain("auto");
	setup.renderer.destroy();
});

test("appears and disappears as auto approval toggles", async () => {
	const service = createPermissionService();
	const setup = await renderIndicator(service);
	expect(setup.captureCharFrame()).not.toContain("auto");

	service.setAutoApproval(true);
	await flushUi(setup);
	expect(setup.captureCharFrame()).toContain("auto");

	service.setAutoApproval(false);
	await flushUi(setup);
	expect(setup.captureCharFrame()).not.toContain("auto");
	setup.renderer.destroy();
});
