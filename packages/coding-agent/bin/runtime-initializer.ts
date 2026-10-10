import type { DispatchDependencies } from "../modules/application/dispatch";
import { initializeApplicationRuntime } from "../modules/application/runtime";

export const initializeWincodeRuntime: NonNullable<
	DispatchDependencies["initializeRuntime"]
> = ({ promptProjectTrust, ...input }) =>
	initializeApplicationRuntime(input, {
		...(promptProjectTrust === undefined ? {} : { promptProjectTrust }),
	});
