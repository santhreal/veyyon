/**
 * The `pi` namespace handed to extensions, hooks, custom tools and commands. Loaded on demand from here,
 * once per process — a static barrel import sat in the startup path and pulled every module on every launch.
 * One owner prevents four separate lazy loads from drifting. Also removes a real import cycle
 * (`index.ts` transitively imports these loaders; a dynamic import can't participate).
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
