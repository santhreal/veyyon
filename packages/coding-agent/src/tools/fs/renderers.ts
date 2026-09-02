/**
 * How a terminal draws the filesystem domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one. The manifest stays free of it, and a headless or
 * browser host reads the manifest without pulling the engine in.
 */
import { viewToolRenderer } from "../../modes/terminal/draw/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { inspectImageToolView } from "./inspect-image-view";
import { readToolView } from "./read-view";
import { setCwdToolView } from "./set-cwd";
import { writeContentExceedsStreamingWindow } from "./write";
import { writeToolView } from "./write-view";

export const fsRenderers: Record<string, ToolRenderer> = {
	read: viewToolRenderer(readToolView, { mergeCallAndResult: true }) as ToolRenderer,
	write: viewToolRenderer(writeToolView, {
		mergeCallAndResult: true,
		// The collapsed pending preview follows the streaming edge with a tail window once the content
		// outgrows it; the first partial result re-anchors the frame to the top of the file, so tail
		// rows already committed to viewport/native scrollback would survive as stale content above
		// the new frame without a full replay. Expanded and short previews stay top-anchored and skip
		// the (scrollback-wiping) reset.
		forceFirstResultViewportRepaint: (args, options) => !options.expanded && writeContentExceedsStreamingWindow(args),
	}) as ToolRenderer,
	set_cwd: viewToolRenderer(setCwdToolView) as ToolRenderer,
	inspect_image: viewToolRenderer(inspectImageToolView, { mergeCallAndResult: true }) as ToolRenderer,
};
