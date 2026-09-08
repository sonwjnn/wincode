import { expect, test } from "bun:test";
import { claimAgentDiagnosticsToast } from "./agent-registry-provider";

test("claims one diagnostics toast per process-lifetime config store", () => {
	const firstStore = {};
	const secondStore = {};

	expect(claimAgentDiagnosticsToast(firstStore)).toBe(true);
	expect(claimAgentDiagnosticsToast(firstStore)).toBe(false);
	expect(claimAgentDiagnosticsToast(secondStore)).toBe(true);
});
