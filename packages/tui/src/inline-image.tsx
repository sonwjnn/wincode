import {
	type ImageRenderProtocol,
	resolveImageRenderProtocol,
} from "@opentui/core";
import { useState } from "react";
import { useRenderer } from "./react-hooks";

type InlineImageProps = Readonly<{
	/** Supported, already available image bytes. No files or URLs are loaded. */
	source: Uint8Array | null;
	/** Text shown when graphics cannot be placed or the image cannot be decoded. */
	fallback: string;
	/** Maximum width of the preview in terminal cells. */
	width: number;
	/** Maximum height of the preview in terminal cells. */
	height: number;
	/** Hiding the preview removes its renderer-owned image placement. */
	visible?: boolean;
}>;

const isBounded = (width: number, height: number): boolean =>
	Number.isSafeInteger(width) &&
	width > 0 &&
	Number.isSafeInteger(height) &&
	height > 0;

/** A renderer-coordinated inline image with a readable text fallback. */
export const InlineImage = ({
	source,
	fallback,
	width,
	height,
	visible = true,
}: InlineImageProps) => {
	const renderer = useRenderer();
	const [failedSource, setFailedSource] = useState<Uint8Array | null>(null);
	const boundsAreValid = isBounded(width, height);
	const canPlaceKittyImage =
		boundsAreValid &&
		source !== null &&
		source.byteLength > 0 &&
		renderer.screenMode === "alternate-screen" &&
		resolveImageRenderProtocol(
			"auto",
			renderer.capabilities,
			renderer.resolution !== null
		) === "kitty";

	if (!visible) {
		return null;
	}

	if (!canPlaceKittyImage || failedSource === source) {
		return (
			<text
				height={boundsAreValid ? height : 1}
				width={boundsAreValid ? width : 1}
			>
				{fallback}
			</text>
		);
	}

	const protocol: ImageRenderProtocol = "kitty";
	return (
		<image
			fit="fit"
			height={height}
			onError={() => setFailedSource(source)}
			protocol={protocol}
			source={source}
			width={width}
		/>
	);
};

export type { InlineImageProps };
