import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useEffect } from "react";
import type {
	ProjectTrustChoice,
	ProjectTrustPromptRequest,
} from "../modules/project-trust/project-trust";
import { registerCrashTeardown } from "../shared/crash-guard";
import {
	DialogProvider,
	useDialog,
} from "../shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "../shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "../shared/providers/theme/theme-provider";
import { requestProjectTrust } from "./commands/project-trust-dialog";

const StartupProjectTrustPrompt = ({
	request,
	settle,
}: Readonly<{
	request: ProjectTrustPromptRequest;
	settle: (choice: ProjectTrustChoice) => void;
}>) => {
	const { open } = useDialog();

	useEffect(() => {
		void requestProjectTrust({ open }, request).then(settle, () =>
			settle("cancel")
		);
	}, [open, request, settle]);

	return null;
};

export const runProjectTrustPreflight = async (
	request: ProjectTrustPromptRequest,
	rendererFactory: typeof createCliRenderer = createCliRenderer
): Promise<ProjectTrustChoice> => {
	const renderer = await rendererFactory({
		enableMouseMovement: true,
		exitOnCtrlC: false,
		useMouse: true,
	});
	const result = Promise.withResolvers<ProjectTrustChoice>();
	const root = createRoot(renderer);
	let settled = false;
	let destroyed = false;
	const settle = (choice: ProjectTrustChoice): void => {
		if (settled) {
			return;
		}
		settled = true;
		result.resolve(choice);
	};
	const destroy = renderer.destroy.bind(renderer);
	renderer.destroy = () => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		try {
			root.unmount();
		} finally {
			destroy();
			settle("cancel");
		}
	};
	const unregisterCrashTeardown = registerCrashTeardown(() =>
		renderer.destroy()
	);

	try {
		root.render(
			<ThemeProvider>
				<KeyboardLayerProvider>
					<DialogProvider>
						<StartupProjectTrustPrompt request={request} settle={settle} />
					</DialogProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>
		);
		return await result.promise;
	} finally {
		unregisterCrashTeardown();
		renderer.destroy();
	}
};
