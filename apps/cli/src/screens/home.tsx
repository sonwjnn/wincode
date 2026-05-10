import { AsciiArt } from "../components/ascii-art";
import { HomeTextArea } from "../components/text-area";

export function HomeScreen() {
	return (
		<box alignItems="center" flexDirection="column" marginTop={4}>
			<AsciiArt />
			<box marginTop={2}>
				<HomeTextArea />
			</box>
		</box>
	);
}
