import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("connection dialog ui", () => {
	test("api key dialog keeps input on failure and blocks duplicate submits", async () => {
		const source = await readFile(
			new URL("./connection-api-key-dialog.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("Failed to save API key.");
		expect(source).toContain("isSubmittingRef.current");
		expect(source).toContain('inputRef.current.value = ""');
		expect(source).toContain("colors.error");
	});

	test("browser waiting dialog keeps live connection and manual open/copy state", async () => {
		const source = await readFile(
			new URL("./connection-browser-waiting-dialog.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("setAuthorizationUrl");
		expect(source).toContain("setStatus");
		expect(source).toContain("signal: controller.signal");
		expect(source).toContain("controller.abort()");
		expect(source).toContain("closeAllDialogs");
		expect(source).toContain("onBrowserOpenUrl");
		expect(source).toContain('key.name === "c"');
		expect(source).toContain("colors.error");
		expect(source).toContain('fg="#58A6FF"');
		expect(source).toContain('wrapMode="char"');
		expect(source).not.toContain('enter" || key.name === "return"');
	});

	test("connect flow opens browser child before connection work starts", async () => {
		const source = await readFile(
			new URL("./connect-dialog.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("onBrowserConnect");
		expect(source).toContain("onBrowserOpenUrl");
		expect(source).toContain("onBrowserOpenUrl={onBrowserOpenUrl}");
		expect(source).toContain("ConnectionBrowserWaitingDialogContent");
		expect(source).toContain("dialog.open");
		expect(source).toContain("const CONNECTION_DIALOG_WIDTH = 72;");
		expect(source).toContain("width: CONNECTION_DIALOG_WIDTH,");
		expect(source).toContain("Choose method");
		expect(source).toContain("API key");
		expect(source).toContain("browser");
		expect(source).toContain("signal: AbortSignal");
		expect(source).toContain("connectedProviderIds");
	});

	test("provider and method pickers keep aligned label columns and connected state", async () => {
		const providerSource = await readFile(
			new URL("./connection-provider-picker-dialog.tsx", import.meta.url),
			"utf8"
		);
		const methodSource = await readFile(
			new URL("./connection-method-picker-dialog.tsx", import.meta.url),
			"utf8"
		);

		expect(providerSource).toContain("CONNECTION_LABEL_COLUMN_WIDTH");
		expect(methodSource).toContain("CONNECTION_LABEL_COLUMN_WIDTH");
		expect(providerSource).toContain("marginLeft={1}");
		expect(providerSource).toContain("width={2}");
		expect(providerSource).toContain("✓");
		expect(providerSource).not.toContain("✓ Connected");
		expect(providerSource).toContain("#22C55E");
		expect(providerSource).toContain("connectedProviders.has(provider.id)");
		expect(methodSource).toContain('overflow="hidden"');
	});
});
