import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@veyyon/utils/worker-host";
import { WorkerCore } from "./worker-core";
import type { EvalWorkerInbound, EvalWorkerOutbound, EvalWorkerTransport } from "./worker-protocol";

if (!parentPort) throw new Error("js worker-entry: missing parentPort");

const port = parentPort;
// When the CLI host pre-buffered messages (it imports this module dynamically), bind that inbox so the parent's already-delivered `init` is replayed. Loaded
const inbox = consumeWorkerInbox();
const transport: EvalWorkerTransport = {
	send: (msg: EvalWorkerOutbound) => port.postMessage(msg),
	onMessage: handler => {
		if (inbox) return inbox.bind(data => handler(data as EvalWorkerInbound));
		const wrap = (data: unknown): void => handler(data as EvalWorkerInbound);
		port.on("message", wrap);
		return () => port.off("message", wrap);
	},
	close: () => {
		try {
			port.close();
		} catch {
			// Already closed.
		}

		// `parentPort.close()` only disconnects the channel in Bun; it does not make the Worker emit `close` or reap ref'ed user handles. Exit from
		setTimeout(() => process.exit(0), 0);
	},
};

new WorkerCore(transport, { mode: "isolated" });
