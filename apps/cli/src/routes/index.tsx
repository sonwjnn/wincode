import { createFileRoute } from "@tanstack/react-router";
import { PromptConfigProvider } from "../providers/prompt-config-provider";
import { HomeScreen } from "../screens/home";

export const Route = createFileRoute("/")({
	component: HomeRoute,
});

function HomeRoute() {
	return (
		<PromptConfigProvider>
			<HomeScreen />
		</PromptConfigProvider>
	);
}
