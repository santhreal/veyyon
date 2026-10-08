/**
 * The server-side compaction transport, evaluated on first use.
 *
 * `openai-compaction.ts` imports the Codex client and the OpenAI request builders, which a session that
 * never compacts server-side does not load. That file is byte-locked
 * (`scripts/the-codex-compaction-route-is-locked.test.ts`), so the deferral is made here. `require`,
 * because both functions are synchronous; a relative specifier, because the package `exports` map
 * declares only the `import` condition and a `require` of `@veyyon/ai/providers/...` does not resolve.
 */

import type { Api, Model } from "../types";
import type * as ServerCompaction from "./openai-compaction";

export type { ServerCompactionRequest, ServerCompactionResult, ServerCompactionTransport } from "./openai-compaction";

let loaded: typeof ServerCompaction | undefined;

function serverCompaction(): typeof ServerCompaction {
	loaded ??= require("./openai-compaction") as typeof ServerCompaction;
	return loaded;
}

/** `resolveServerCompactionTransport` from `./openai-compaction`. */
export function resolveServerCompactionTransport(
	model: Model<Api>,
): ServerCompaction.ServerCompactionTransport | undefined {
	return serverCompaction().resolveServerCompactionTransport(model);
}

/** `serverCompactionRouteAbsent` from `./openai-compaction`. */
export function serverCompactionRouteAbsent(model: Model<Api>): boolean {
	return serverCompaction().serverCompactionRouteAbsent(model);
}
