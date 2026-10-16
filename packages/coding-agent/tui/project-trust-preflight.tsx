import { useEffect } from "react";
import type {
	ProjectTrustChoice,
	ProjectTrustPromptRequest,
} from "../modules/project-trust/project-trust";
import {
	DialogProvider,
	useDialog,
} from "../shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "../shared/providers/keyboard-layer/keyboard-layer-provider";
import { requestProjectTrust } from "./commands/project-trust-dialog";
import type { RendererSession } from "./renderer-session";

const StartupProjectTrustPrompt = ({
	request,
	settle,
}: Readonly<{
	request: ProjectTrustPromptRequest;
	settle: (choice: ProjectTrustChoice) => void;
}>) => {
	const { open } = useDialog();

	useEffect(() => {
		void requestProjectTrust(
			{ open },
			{ ...request, includeSessionOnly: true, showTrustStatus: false }
		).then(settle, () => settle("cancel"));
	}, [open, request, settle]);

	return null;
};

export const runProjectTrustPreflight = async (
	request: ProjectTrustPromptRequest,
	session: RendererSession
): Promise<ProjectTrustChoice> => {
	const result = Promise.withResolvers<ProjectTrustChoice>();
	let settled = false;
	const settle = (choice: ProjectTrustChoice): void => {
		if (settled) {
			return;
		}
		settled = true;
		result.resolve(choice);
	};

	session.render(
		<KeyboardLayerProvider>
			<DialogProvider>
				<StartupProjectTrustPrompt request={request} settle={settle} />
			</DialogProvider>
		</KeyboardLayerProvider>
	);
	try {
		return await result.promise;
	} finally {
		session.renderStartupBackground();
	}
};
