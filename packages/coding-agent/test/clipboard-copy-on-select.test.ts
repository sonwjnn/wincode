import { describe, expect, test } from "bun:test";
import { handleSelection } from "@/shared/clipboard/copy-on-select";

const selection = (text: string) => ({ getSelectedText: () => text });
const baseRenderer = () => ({
	copyToClipboardOSC52: () => false,
	clearSelection: () => undefined,
});

describe("handleSelection", () => {
	test("preserves the selection without copying or toasting when disabled", async () => {
		let writes = 0;
		let clears = 0;
		const toasts: unknown[] = [];
		await handleSelection(
			selection("hello"),
			{
				...baseRenderer(),
				clearSelection: () => {
					clears += 1;
				},
			},
			(toast) => toasts.push(toast),
			{
				enabled: false,
				write: async () => {
					writes += 1;
					return true;
				},
			}
		);
		expect(writes).toBe(0);
		expect(toasts).toHaveLength(0);
		expect(clears).toBe(0);
	});

	test("ignores empty selection", async () => {
		let writes = 0;
		const renderer = baseRenderer();
		await handleSelection(selection(""), renderer, () => undefined, {
			write: async () => {
				writes += 1;
				return true;
			},
		});
		expect(writes).toBe(0);
	});

	test("writes once, toasts, and clears on success or failure", async () => {
		for (const [result, expectedWidth] of [
			[true, 30],
			[false, undefined],
		] as const) {
			let clears = 0;
			let writes = 0;
			const toasts: { message: string; width?: number }[] = [];
			await handleSelection(
				selection("hello"),
				{
					...baseRenderer(),
					clearSelection: () => {
						clears += 1;
					},
				},
				(toast) => toasts.push(toast),
				{
					write: async () => {
						writes += 1;
						return result;
					},
				}
			);
			expect(writes).toBe(1);
			expect(clears).toBe(1);
			expect(toasts).toHaveLength(1);
			expect(toasts[0]?.width).toBe(expectedWidth);
		}
	});

	test("clears and reports rejected writes", async () => {
		let clears = 0;
		const toasts: string[] = [];
		await handleSelection(
			selection("hello"),
			{
				...baseRenderer(),
				clearSelection: () => {
					clears += 1;
				},
			},
			(toast) => toasts.push(toast.message),
			{
				write: async () => {
					throw new Error("failed");
				},
			}
		);
		expect(clears).toBe(1);
		expect(toasts).toEqual(["Failed to copy selection."]);
	});
});
