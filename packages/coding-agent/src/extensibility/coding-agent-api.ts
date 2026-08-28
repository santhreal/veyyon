/** The `pi` namespace handed to extensions, hooks, custom tools and custom commands. Every extensibility surface gives its author the whole package as one object, so each loader used to */

import { once } from "@veyyon/utils";

/** The package's public surface, as an extension author sees it through `api.pi`. */
export type CodingAgentApi = typeof import("../index");

/** The package namespace, imported on first use and reused afterwards. Callers are async already; await this where the API object is built, not at module scope, or the */
export const loadCodingAgentApi: () => Promise<CodingAgentApi> = once(() => import("../index"));
