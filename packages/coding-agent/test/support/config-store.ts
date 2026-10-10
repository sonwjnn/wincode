import { createConfigStore } from "@/shared/config/config-store";

export const TEST_CONFIG_ROOT = "/home/user/.wincode";
export const TEST_HOME_ROOT = "/home/user";

export const createInMemoryConfigStore = (
	files: Record<string, string> = {},
	trustedProjectRoots: readonly string[] = []
) =>
	createConfigStore({
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
		trustedProjectRoots,
	});
