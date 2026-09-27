import { createConfigStore } from "@/shared/config/config-store";

export const TEST_CONFIG_ROOT = "/home/user/.config/wincode";
export const TEST_HOME_ROOT = "/home/user";

export const createInMemoryConfigStore = (files: Record<string, string> = {}) =>
	createConfigStore({
		configRoot: TEST_CONFIG_ROOT,
		fs: {
			readFile: async (file) => {
				const contents = files[file];
				if (contents === undefined) {
					throw Object.assign(new Error("missing"), { code: "ENOENT" });
				}
				return contents;
			},
			writeFile: async (file, contents) => {
				files[file] = contents;
			},
		},
		homeRoot: TEST_HOME_ROOT,
	});
