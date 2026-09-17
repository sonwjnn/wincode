import { describe, expect, test } from "bun:test";
import { omitUndefined } from "../src/index";

describe("omitUndefined", () => {
	test("drops keys whose value is undefined", () => {
		expect(omitUndefined({ present: 1, missing: undefined })).toStrictEqual({
			present: 1,
		});
	});

	test("keeps falsy values that are not undefined", () => {
		const result = omitUndefined({
			zero: 0,
			missing: undefined,
			empty: "",
			no: false,
			nothing: null,
			notANumber: Number.NaN,
		});

		expect(Object.keys(result)).toEqual([
			"zero",
			"empty",
			"no",
			"nothing",
			"notANumber",
		]);
	});

	test("returns an empty object when every value is undefined", () => {
		expect(omitUndefined({ a: undefined, b: undefined })).toStrictEqual({});
	});

	test("does not mutate its input", () => {
		const input: { kept: number; dropped?: undefined } = {
			kept: 1,
			dropped: undefined,
		};

		const result = omitUndefined(input);

		expect(Object.keys(input)).toEqual(["kept", "dropped"]);
		expect(result).not.toBe(input);
	});
});
