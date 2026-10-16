import { expect, test } from "bun:test";
import { formatStartupDiagnostics } from "../../modules/application/startup-diagnostics";

test("startup diagnostics use the same channel-independent labels", () => {
	expect(
		formatStartupDiagnostics({
			pluginDiagnostics: [
				{ message: "Plugin failed to load", sourcePath: "/repo/plugin.ts" },
			],
			projectTrustDiagnostics: ["protected project resources were omitted"],
		})
	).toEqual([
		"Project trust: protected project resources were omitted",
		"Plugin: Plugin failed to load (/repo/plugin.ts)",
	]);
});
