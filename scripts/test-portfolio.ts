import { runTestPortfolio } from "@wincode/test-runner";

if (import.meta.main) {
	process.exitCode = await runTestPortfolio(process.argv.slice(2));
}
