// Subpath import: the pi-utils barrel loads dotenv at import time, which must
// not happen before profile bootstrap (see process-entry-import.test.ts).
import * as postmortem from "@veyyon/utils/postmortem";
import { WorkerCore } from "./worker-core";
import type { EvalWorkerInbound, EvalWorkerOutbound } from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(transport: {
	send(message: EvalWorkerOutbound): void;
	onMessage(handler: (message: EvalWorkerInbound) => void): () => void;
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
			// The subprocess starts with its real cwd at the worker-host entry dir (a `resolveWorkerSpawnCmd` requirement); mirror the session cwd so
			chdir: cwd => process.chdir(cwd),
			// This subprocess is a real main thread, so postmortem's global unhandledRejection handler is live here: cell-rejection attribution
			interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
		},
	);
}
