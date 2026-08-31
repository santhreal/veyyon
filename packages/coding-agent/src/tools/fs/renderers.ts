/**
 * How a terminal draws the filesystem domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one. The manifest stays free of it, and a headless or
 * browser host reads the manifest without pulling the engine in.
 */
import type { ToolRenderer } from "../renderers";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { readToolRenderer } from "./read-render";
import { setCwdToolRenderer } from "./set-cwd-render";
import { writeToolRenderer } from "./write-render";

export const fsRenderers: Record<string, ToolRenderer> = {
	read: readToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
	set_cwd: setCwdToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
};
