import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionsProvider } from "../context/connections-provider";
import type { Connections } from "../contract";
import {
	connectProviderApiKey,
	connectProviderBrowser,
} from "./connect-dialog";

test("api key helper uses injected connections facade", async () => {
	let seenRequest: unknown;
	const connections = {
		authorize: async () => ({ kind: "api-key", apiKey: "x" }),
		connect: async (request) => {
			seenRequest = request;
		},
		listProviders: async () => [],
	} satisfies Connections;

	renderToStaticMarkup(
		<ConnectionsProvider connections={connections}>
			<text>ok</text>
		</ConnectionsProvider>
	);

	const controller = new AbortController();
	await connectProviderApiKey(
		connections,
		"openai",
		"sk-test",
		controller.signal
	);

	expect(seenRequest).toEqual({
		apiKey: "sk-test",
		method: "api-key",
		signal: controller.signal,
		providerId: "openai",
	});
});

test("api key helper forwards abort signal", async () => {
	const controller = new AbortController();
	const connections = {
		authorize: async () => ({ kind: "api-key", apiKey: "x" }),
		connect: async (request) => {
			expect(request.signal).toBe(controller.signal);
			request.signal?.throwIfAborted();
		},
		listProviders: async () => [],
	} satisfies Connections;
	controller.abort();
	await expect(
		connectProviderApiKey(connections, "openai", "sk-test", controller.signal)
	).rejects.toThrow();
});

test("browser helper uses injected connections facade", async () => {
	let seenRequest: unknown;
	const connections = {
		authorize: async () => ({ kind: "api-key", apiKey: "x" }),
		connect: async (request) => {
			seenRequest = request;
		},
		listProviders: async () => [],
	} satisfies Connections;
	const provider = {
		connected: false,
		displayName: "Wincode",
		id: "wincode",
		methods: ["api-key", "browser"],
	} as const;

	await connectProviderBrowser(connections, provider, {
		setAuthorizationUrl: () => undefined,
		setStatus: () => undefined,
		signal: new AbortController().signal,
	});

	expect(seenRequest).toMatchObject({
		method: "browser",
		providerId: "wincode",
	});
});
