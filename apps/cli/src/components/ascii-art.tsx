export function AsciiArt() {
	return (
		<box alignItems="center" justifyContent="center">
			<box
				alignItems="center"
				flexDirection="row"
				gap={0.5}
				justifyContent="center"
			>
				<ascii-font color="gray" font="tiny" text="Win" />
				<ascii-font font="tiny" text="Code" />
			</box>
		</box>
	);
}
