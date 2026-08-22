/**
 * Minimal reproduction for OpenTUI's negative fillRect coordinate bug.
 *
 * Run against the workspace renderer:
 *   bun run scripts/opentui-diff-clipping-repro.ts
 *
 * Compare another package build by pointing at its absolute entry module:
 *   OPENTUI_CORE_SPECIFIER=/tmp/opentui/package/index.node.js \
 *     bun run scripts/opentui-diff-clipping-repro.ts
 */
const REPRO_BUFFER_WIDTH = 4;
const REPRO_BUFFER_HEIGHT = 2;
const COLOR_CHANNEL_COUNT = 4;

const coreSpecifier = process.env.OPENTUI_CORE_SPECIFIER ?? "@opentui/core";
const { OptimizedBuffer, RGBA } = await import(coreSpecifier);
const background = RGBA.fromValues(10, 10, 10, 1);
const bleed = RGBA.fromValues(200, 0, 0, 1);
const buffer = OptimizedBuffer.create(
	REPRO_BUFFER_WIDTH,
	REPRO_BUFFER_HEIGHT,
	"wcwidth"
);

try {
	buffer.clear(background);
	// A one-row lane that ends immediately above the viewport must not paint row 0.
	buffer.fillRect(0, -1, buffer.width, 1, bleed);

	const topRowHasBleed = Array.from(
		{ length: REPRO_BUFFER_WIDTH },
		(_, column) => {
			const offset = column * COLOR_CHANNEL_COUNT;
			return bleed.buffer.every(
				(channel, channelIndex) =>
					buffer.buffers.bg[offset + channelIndex] === channel
			);
		}
	).some(Boolean);

	if (topRowHasBleed) {
		throw new Error(
			`negative fillRect coordinate painted the viewport edge (${coreSpecifier})`
		);
	}

	console.log(`OpenTUI fillRect boundary passed (${coreSpecifier})`);
} finally {
	buffer.destroy();
}
