import "dotenv/config";

export function getPort(defaultPort: number): number {
	const port = Number(process.env.PORT ?? defaultPort);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
}
