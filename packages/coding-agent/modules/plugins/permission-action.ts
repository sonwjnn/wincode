import { isNativeToolPermissionAction } from "@/modules/permissions/policy";
import type { PluginToolDescriptor } from "./runtime";

/** Keeps Plugin-chosen aliases inside their owner's permission namespace. */
export const permissionActionForPluginTool = (
	tool: Pick<PluginToolDescriptor, "action" | "permissionAction" | "pluginId">
): string => {
	const requestedAction = tool.permissionAction ?? tool.action;
	const pluginPrefix = `plugin:${tool.pluginId}:`;
	if (requestedAction.startsWith("plugin:")) {
		return requestedAction.startsWith(pluginPrefix)
			? requestedAction
			: tool.action;
	}
	return isNativeToolPermissionAction(requestedAction)
		? `${pluginPrefix}${requestedAction}`
		: requestedAction;
};
