/**
 * Every execution backend in this repository, and the one call that registers them.
 *
 * A backend owns how a trial is started, isolated and torn down: Pier and Harbor
 * each run a container, in-process drives an `AgentSession` in this process. A
 * suite names the backend it needs through `EvalSuite.backend`.
 *
 * The backend trees are NOT re-exported here: Harbor and the in-process client
 * both name a command executor and an argument parser, and a star that merges them
 * silently picks one. Import a backend's own module directly, as
 * `@veyyon/evals/backends/harbor/backend`.
 */

import { type BackendRegistry, defaultBackendRegistry } from "../core/backend-registry";
import { harborBackend } from "./harbor/backend";
import { inProcessBackend } from "./in-process/backend";
import { pierBackend } from "./pier/backend";

export const builtinBackends = [pierBackend, harborBackend, inProcessBackend] as const;

/**
 * Registers every built-in backend in the given (or default) registry. Idempotent
 * per registry.
 */
export function registerAllBackends(registry: BackendRegistry = defaultBackendRegistry): void {
	for (const backend of builtinBackends) {
		if (!registry.has(backend.id)) {
			registry.register(backend);
		}
	}
}
