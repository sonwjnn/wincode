import * as path from "node:path";
import { parseProviderModelSelection } from "../../packages/ai/src/sdk";
import { createProviderSdkCredentialStore } from "../../packages/coding-agent/modules/providers/provider-stores";
import { resolveUserDataDir } from "../../packages/coding-agent/shared/paths/user-data-dir";

const selection = parseProviderModelSelection(
	process.env.WINCODE_SMOKE_MODEL ?? ""
);
const sourceHome = process.env.WINCODE_SMOKE_SOURCE_HOME;
const isolatedHome = process.env.WINCODE_SMOKE_HOME;
if (
	selection === null ||
	!sourceHome ||
	!path.isAbsolute(sourceHome) ||
	!isolatedHome ||
	!path.isAbsolute(isolatedHome)
) {
	throw new Error(
		"Live smoke requires a Provider/model and configured user directories."
	);
}

const sourceUserDataDir = resolveUserDataDir(
	{
		XDG_DATA_HOME: process.env.WINCODE_SMOKE_SOURCE_XDG_DATA_HOME || undefined,
		APPDATA: process.env.WINCODE_SMOKE_SOURCE_APPDATA || undefined,
	},
	sourceHome
);
const isolatedUserDataDir = resolveUserDataDir(
	{
		XDG_DATA_HOME:
			process.env.WINCODE_SMOKE_ISOLATED_XDG_DATA_HOME || undefined,
		APPDATA: process.env.WINCODE_SMOKE_ISOLATED_APPDATA || undefined,
	},
	isolatedHome
);
if (sourceUserDataDir === isolatedUserDataDir) {
	throw new Error(
		"Live smoke requires an isolated temporary Provider credential store."
	);
}

const credential = await createProviderSdkCredentialStore({
	userDataDir: sourceUserDataDir,
}).read(selection.providerId);
if (credential === undefined) {
	throw new Error(
		`No configured credential exists for Provider '${selection.providerId}'. Configure it in Wincode before live smoke.`
	);
}

// Copy only the selected Provider credential; all writes go to the isolated test home.
await createProviderSdkCredentialStore({
	userDataDir: isolatedUserDataDir,
}).modify(selection.providerId, () => credential);
