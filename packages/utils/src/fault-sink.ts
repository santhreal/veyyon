import * as logger from "./logger";

export interface Fault {
	source: string;
	text: string;
	context?: Record<string, unknown>;
}

export type FaultSink = (fault: Fault) => void;

export type DetachFaultSink = () => void;

const attached = new Set<FaultSink>();

export function attachFaultSink(sink: FaultSink): DetachFaultSink {
	attached.add(sink);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		attached.delete(sink);
	};
}

export function faultSinkCount(): number {
	return attached.size;
}

export function reportFault(fault: Fault): void {
	logger.warn(`${fault.source}: ${fault.text}`, fault.context ?? {});
	for (const sink of Array.from(attached)) {
		try {
			sink(fault);
		} catch (error) {
			logger.warn("A fault sink threw while reporting a fault; the fault above is in the log only", {
				source: fault.source,
				error: String(error),
			});
		}
	}
}
