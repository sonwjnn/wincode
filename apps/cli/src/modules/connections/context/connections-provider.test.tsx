import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connections } from "../contract";
import { ConnectionsProvider, useConnections } from "./connections-provider";

test("ConnectionsProvider exposes injected connections", async () => {
	const connections = {
		authorize: async () => ({ kind: "api-key", apiKey: "x" }),
		connect: async () => undefined,
		listProviders: async () => [],
	} satisfies Connections;

	const seen: Connections[] = [];

	function Probe() {
		const current = useConnections();
		seen.push(current);
		return <text>{current === connections ? "ok" : "bad"}</text>;
	}

	renderToStaticMarkup(
		<ConnectionsProvider connections={connections}>
			<Probe />
		</ConnectionsProvider>
	);
	renderToStaticMarkup(
		<ConnectionsProvider connections={connections}>
			<Probe />
		</ConnectionsProvider>
	);

	expect(seen[0]).toBe(connections);
	expect(seen[1]).toBe(connections);
});
