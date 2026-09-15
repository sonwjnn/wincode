import { isNonEmptyString } from "@wincode/runtime-utils";

export type ErrorResponse = {
	json: () => Promise<unknown>;
	status: number;
	statusText: string;
};

export async function getErrorMessage(response: ErrorResponse) {
	try {
		const data = (await response.json()) as { error?: string };
		if (isNonEmptyString(data.error)) {
			return data.error;
		}
	} catch {
		// Ignore invalid error payloads and fall back to the status text below.
	}

	return response.statusText || `Request failed with status ${response.status}`;
}
