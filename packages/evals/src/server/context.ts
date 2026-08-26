/**
 * Server execution context passed to route controllers.
 *
 * Encapsulates the run store, jobs directory, token auth, SSE stream, and runner process manager.
 */
import type { RunStore } from "../manager/store";
import type { RunnerManager } from "./runner";
import type { SseStream } from "./sse";

export interface ServerContext {
	readonly store: RunStore;
	readonly jobsDir: string;
	readonly token: string;
	readonly sse: SseStream;
	readonly runner: RunnerManager;
	readonly onTick: () => void;
}
