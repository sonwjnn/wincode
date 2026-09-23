import { expect, test } from "bun:test";
import { projectAgentEvent } from "../modules/application/rpc/projection";

test("public Agent Turn projection preserves empty delta events", () => {
	for (const type of ["text-delta", "reasoning-delta"] as const) {
		expect(
			projectAgentEvent({ delta: "", sequence: 0, turnId: "turn-1", type })
		).toEqual({ delta: "", sequence: 0, turnId: "turn-1", type });
	}
});
