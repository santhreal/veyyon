// Subpath import: the pi-utils barrel loads dotenv at import time, which must
// not happen before profile bootstrap (see process-entry-import.test.ts).
import * as postmortem from "@veyyon/utils/postmortem";
import { WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(transport: {
	send(message: WorkerOutbound): void;
	onMessage(handler: (message: WorkerInbound) => void): () => void;
}): void {
	new WorkerCore(
		{
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed IPC.
			close: () => {},
		},
		{
			mode: "isolated",
			// The subprocess starts with its real cwd at the worker-host entry dir
			// (a `resolveWorkerSpawnCmd` requirement); mirror the session cwd so
			// cell code using relative paths or spawning children resolves against
			// the project instead of the install dir. Worker threads cannot pass
			// this — `process.chdir` is unavailable there.
			chdir: cwd => process.chdir(cwd),
			// This subprocess is a real main thread, so postmortem's global
			// unhandledRejection handler is live here: cell-rejection attribution
			// must go through its interceptor chain or the fatal report + exit(1)
			// kills the worker before the run result crosses IPC.
			interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
		},
	);
}
