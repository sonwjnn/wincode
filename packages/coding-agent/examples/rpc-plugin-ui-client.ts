type RpcFrame = Readonly<Record<string, unknown>>;
type RpcPluginUIRequest = Readonly<{
	id: string;
	params: Readonly<Record<string, unknown>>;
}>;
type RpcPluginUIResult = string | boolean | null;
type PluginUINotification = Readonly<{
	method: string;
	params: Readonly<Record<string, unknown>>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const createPluginUIInitializeFrame = (cwd: string): RpcFrame => ({
	id: "initialize",
	jsonrpc: "2.0",
	method: "initialize",
	params: {
		capabilities: { pluginUi: { version: 1 } },
		clientInfo: { name: "rpc-plugin-ui-example", version: "1" },
		cwd,
		protocolVersion: 4,
	},
});

const resultFor = (params: Record<string, unknown>): RpcPluginUIResult => {
	switch (params.kind) {
		case "select": {
			const choices = params.choices;
			return Array.isArray(choices) && typeof choices[0] === "string"
				? choices[0]
				: null;
		}
		case "confirm":
			return true;
		case "input":
			return "example input";
		case "editor":
			return typeof params.initialValue === "string"
				? params.initialValue
				: "example text";
		default:
			return null;
	}
};

export const handlePluginUIFrame = (
	frame: unknown,
	onNotification: (notification: PluginUINotification) => void = () => undefined
): RpcFrame | undefined => {
	if (!isRecord(frame)) {
		return;
	}
	if (
		frame.method === "plugin/ui/notify" ||
		frame.method === "plugin/ui/update"
	) {
		if (isRecord(frame.params)) {
			onNotification({ method: frame.method, params: frame.params });
		}
		return;
	}
	if (
		frame.jsonrpc !== "2.0" ||
		frame.method !== "plugin/ui/request" ||
		typeof frame.id !== "string" ||
		!isRecord(frame.params)
	) {
		return;
	}
	const request: RpcPluginUIRequest = {
		id: frame.id,
		params: frame.params,
	};
	return {
		id: request.id,
		jsonrpc: "2.0",
		result: resultFor(request.params),
	};
};

/** Receives server frames and writes only matching UI request responses. */
export const runPluginUIProtocolClient = async ({
	cwd,
	onNotification,
	send,
	serverFrames,
}: Readonly<{
	cwd: string;
	onNotification?: (notification: PluginUINotification) => void;
	send: (frame: RpcFrame) => Promise<void> | void;
	serverFrames: AsyncIterable<unknown>;
}>): Promise<void> => {
	const notify = onNotification ?? (() => undefined);
	await send(createPluginUIInitializeFrame(cwd));
	for await (const frame of serverFrames) {
		const response = handlePluginUIFrame(frame, notify);
		if (response !== undefined) {
			await send(response);
		}
	}
};
