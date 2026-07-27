/**
 * The `pi` namespace handed to extensions, hooks, custom tools and custom commands.
 *
 * Every extensibility surface gives its author the whole package as one object, so each loader used to
 * hold `import * as PiCodingAgent from "../../index"` -- a static, value-level import of the package
 * barrel. Three of those loaders sit in the startup path (extension, custom-tool and custom-command
 * discovery all run before the first paint), which meant the barrel, and therefore EVERY module the
 * library exports, loaded on every launch: `src/index.ts` re-exports `./modes`, whose barrel re-exports
 * `interactive-mode`, which pulls the entire `modes/components` subtree. A `veyyon -p "hi"` run with no
 * extensions installed loaded the settings overlay, the plugin-settings panel and the interactive mode it
 * would never construct, and `main.ts`'s deliberate `import("./modes/interactive-mode")` -- written so
 * print, rpc and acp runs "never pay for it at all" -- bought nothing, because the barrel had already
 * pulled the same subtree in behind its back.
 *
 * So the namespace is loaded on demand instead, from here, once per process. A run with no extensibility
 * files never touches the barrel; a run with one pays for it at the moment an author's factory needs it,
 * which is already `async`. Being the single owner is the point: four separate lazy loads would each
 * re-import the barrel and would drift apart, and one of them would eventually be written eagerly again.
 *
 * This also removes a real cycle hazard rather than commenting around it. `index.ts` transitively imports
 * these loaders, so the static self-reference was a genuine import cycle that only worked because nothing
 * dereferenced the namespace during module evaluation -- a rule enforced by a comment. A dynamic import
 * cannot participate in the cycle at all.
 */

import { once } from "@veyyon/utils";

/** The package's public surface, as an extension author sees it through `api.pi`. */
export type CodingAgentApi = typeof import("../index");

/**
 * The package namespace, imported on first use and reused afterwards.
 *
 * Callers are async already; await this where the API object is built, not at module scope, or the
 * eager-barrel problem comes straight back.
 */
export const loadCodingAgentApi: () => Promise<CodingAgentApi> = once(() => import("../index"));
