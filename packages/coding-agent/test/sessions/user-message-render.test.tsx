import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { buildAgent } from "@/modules/agents";
import { UserMessage } from "@/modules/sessions/ui/messages/user-message";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { flushTestRenderer as flush } from "../support/opentui";

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
		await flush(setup, 3);
		const frame = setup.captureCharFrame();

		expect(frame).toContain("Review this patch");
		expect(frame).not.toContain("**");
	} finally {
		act(() => setup.renderer.destroy());
	}
});
