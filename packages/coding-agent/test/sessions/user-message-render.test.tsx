import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { buildAgent } from "@/modules/agents";
import { UserMessage } from "@/modules/sessions/ui/messages/user-message";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";

test("renders Markdown syntax in user messages instead of showing raw markers", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<UserMessage
				agent={buildAgent.id}
				parts={[{ text: "**Review this patch**", type: "text" }]}
			/>
		</ThemeProvider>,
		{ height: 8, width: 80 }
	);

	try {
		await act(async () => {
			for (let pass = 0; pass < 3; pass += 1) {
				await Bun.sleep(20);
				await setup.renderOnce();
			}
		});
		const frame = setup.captureCharFrame();

		expect(frame).toContain("Review this patch");
		expect(frame).not.toContain("**");
	} finally {
		act(() => setup.renderer.destroy());
	}
});
