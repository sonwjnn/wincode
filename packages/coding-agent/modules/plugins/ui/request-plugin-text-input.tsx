import { createElement } from "react";
import type { DialogContextValue } from "@/shared/providers/dialog/dialog-provider";
import type { PluginStatusPanelActionContext } from "../public";
import { PluginTextInputDialog } from "./plugin-text-input-dialog";

export type RequestPluginTextInput =
	PluginStatusPanelActionContext["requestTextInput"];

/** Opens one host-owned text prompt for a Plugin interaction. */
export const createPluginTextInputRequester =
	(
		dialog: Pick<DialogContextValue, "open" | "close">
	): RequestPluginTextInput =>
	(prompt, signal) => {
		const result = Promise.withResolvers<string | undefined>();
		if (signal.aborted) {
			result.resolve(undefined);
			return result.promise;
		}
		let settled = false;
		const settle = (value: string | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", abort);
			result.resolve(value);
		};
		const abort = (): void => {
			dialog.close();
			settle(undefined);
		};
		signal.addEventListener("abort", abort, { once: true });
		dialog.open({
			children: createElement(PluginTextInputDialog, {
				onResolve: settle,
				prompt,
			}),
			title: "Plugin Input",
		});
		return result.promise;
	};
