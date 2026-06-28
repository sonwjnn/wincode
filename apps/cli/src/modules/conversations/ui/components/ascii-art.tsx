export function AsciiArt() {
	return (
		<box alignItems="center" justifyContent="center">
			<box
				alignItems="center"
				flexDirection="row"
				gap={0.5}
				justifyContent="center"
			>
				<ascii-font color="gray" font="block" text="Win" />
				<ascii-font font="block" text="Code" />
			</box>
		</box>
	);
}
