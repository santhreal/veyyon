/**
 * How a terminal draws the shell domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import type { ToolRenderer } from "../renderers";
import { bashToolRenderer } from "./bash-render";
import { debugToolRenderer } from "./debug-render";
import { evalToolRenderer } from "./eval-render";
import { jobToolRenderer } from "./job-render";
import { launchToolRenderer } from "./launch-render";
import { sshToolRenderer } from "./ssh-render";

export const shellRenderers: Record<string, ToolRenderer> = {
	bash: bashToolRenderer as ToolRenderer,
	launch: launchToolRenderer as ToolRenderer,
	job: jobToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
};
