import { describe, expect, test } from "bun:test";
import {
	openExternalLink,
	subscribeLinkOpenFailures,
} from "@/shared/links/open-external-link";

const collectFailures = () => {
	let failures = 0;
	const unsubscribe = subscribeLinkOpenFailures(() => {
		failures += 1;
	});
	return { failures: () => failures, unsubscribe };
};

describe("openExternalLink", () => {
	test("opens supported links", async () => {
		const opened: string[] = [];
		const { failures, unsubscribe } = collectFailures();
		try {
			const result = await openExternalLink("https://example.com", (url) => {
				opened.push(url);
				return Promise.resolve();
			});

			expect(result).toBe(true);
			expect(opened).toEqual(["https://example.com"]);
			expect(failures()).toBe(0);
		} finally {
			unsubscribe();
		}
	});

	test("publishes opener failures so the toast layer can report them", async () => {
		const error = new Error("no browser");
		const { failures, unsubscribe } = collectFailures();
		try {
			const result = await openExternalLink("https://example.com", () =>
				Promise.reject(error)
			);

			expect(result).toBe(false);
			expect(failures()).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	test("a throwing failure listener does not reject the link open result", async () => {
		const unsubscribe = subscribeLinkOpenFailures(() => {
			throw new Error("toast unavailable");
		});
		try {
			const result = await openExternalLink("https://example.com", () =>
				Promise.reject(new Error("no browser"))
			);

			expect(result).toBe(false);
		} finally {
			unsubscribe();
		}
	});

	test("ignores unsupported or malformed links without opening them", async () => {
		const opened: string[] = [];
		const { failures, unsubscribe } = collectFailures();
		try {
			const opener = (url: string) => {
				opened.push(url);
				return Promise.resolve();
			};

			expect(await openExternalLink("mailto:hello@example.com", opener)).toBe(
				false
			);
			expect(await openExternalLink("not a url", opener)).toBe(false);
			expect(opened).toEqual([]);
			expect(failures()).toBe(0);
		} finally {
			unsubscribe();
		}
	});
});
