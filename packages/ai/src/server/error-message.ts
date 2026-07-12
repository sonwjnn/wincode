import { z } from "zod";

const errorBodySchema = z.object({
	error: z
		.union([z.string().min(1), z.object({ message: z.string().min(1) })])
		.optional(),
	message: z.string().min(1).optional(),
});

const parseResponseBody = (responseBody: unknown): string | undefined => {
	if (typeof responseBody !== "string" || responseBody.length === 0) {
		return;
	}

	try {
		const parsed = errorBodySchema.safeParse(JSON.parse(responseBody));
		if (!parsed.success) {
			return responseBody;
		}

		if (typeof parsed.data.error === "string") {
			return parsed.data.error;
		}

		return parsed.data.error?.message ?? parsed.data.message ?? responseBody;
	} catch {
		return responseBody;
	}
};

export const getProviderErrorMessage = (error: unknown): string => {
	const visited = new Set<unknown>();
	let current: unknown = error;
	let fallback = "Chat request failed.";

	while (current !== null && current !== undefined && !visited.has(current)) {
		visited.add(current);

		if (current instanceof Error && current.message) {
			fallback = current.message;
		}

		if (typeof current !== "object") {
			break;
		}

		if ("responseBody" in current) {
			const responseMessage = parseResponseBody(current.responseBody);
			if (responseMessage) {
				return responseMessage;
			}
		}

		current = "cause" in current ? current.cause : undefined;
	}

	return fallback;
};
