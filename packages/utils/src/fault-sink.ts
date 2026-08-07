/**
 * Where a low layer reports a fault it cannot throw for, so the report can actually reach a person.
 *
 * WHY THIS EXISTS. `fs-optional.ts` opens by saying its subject's failure "is not allowed to be
 * silent", and then reports every failure with `logger.warn`. The default transport set is
 * `{ file: true }` with no console transport (`logger.ts`), and no TUI can write to the console
 * without corrupting its own render, so the warning landed in a file nobody opens. The module was
 * self-refuting: `pathExists` documents that it "fixes what `existsSync` cannot express" by
 * reporting a path that exists and cannot be stat'd, and `plugin doctor` documents that it uses
 * `pathExists` for exactly that reason, while in practice a permissions problem was reported to
 * nobody and read as absence at every call site. That is the Law 10 silent fallback the module was
 * written to remove, sitting inside the module.
 *
 * `OperatorNotices` in `packages/coding-agent/src/session/operator-notices.ts` is the channel that
 * does reach a surface, but it lives a layer ABOVE this one and is constructed per session, and the
 * functions that find these faults are free functions with no session handle. So the direction is
 * inverted: this layer owns a sink, and whoever owns a surface attaches theirs to it.
 *
 * MODULE-LEVEL, WHICH IS THE OPPOSITE OF WHAT `OperatorNotices` CHOSE, and deliberately. That class
 * refuses to be a singleton so two sessions in one process cannot cross-post each other's warnings.
 * The faults reported HERE are properties of the MACHINE, not of a session: a directory that cannot
 * be listed, a path that cannot be stat'd, a mount that is gone. Both sessions are affected by it
 * and both operators need to know, so cross-posting is the correct answer rather than a leak, and
 * `OperatorNotices` collapses the duplicate by text anyway.
 *
 * A SET OF SINKS, NOT ONE SLOT, WHICH IS WHAT MAKES THAT CROSS-POSTING TRUE. The first version held a
 * single `FaultSink` and a `setFaultSink` that overwrote it, which did the exact opposite of the
 * paragraph above: `createAgentSession` attaches as it builds, so opening a second session REPLACED
 * the first session's sink and every later fault reached the newer surface only. The older operator
 * got silence, which is the failure mode this file exists to remove, reintroduced by the plumbing.
 * Sinks accumulate now, delivery fans out, and each attach hands back its own detach so a surface
 * removes itself and nothing else.
 *
 * ATTACHING A SINK ADDS REACH AND NEVER REMOVES THE RECORD. Every fault is written to the file log
 * with its structured context first, then forwarded. So the file log stays complete for diagnosis,
 * a process that never attaches a sink behaves exactly as it did before this file existed, and
 * there is no configuration in which a fault is reported to strictly fewer places than before.
 */

import * as logger from "./logger";

/** One fault: something a low layer could not do, and could not throw for. */
export interface Fault {
	/**
	 * Which subsystem could not do the thing, lowercase, one word where possible.
	 *
	 * The same field as `OperatorNotice.source` and rendered the same way, so a fault forwarded to
	 * that channel is indistinguishable from one raised there directly.
	 */
	source: string;
	/** What went wrong and what to do about it. Never contains a credential. */
	text: string;
	/**
	 * Structured detail for the file log: the path, the errno, whatever names the fault.
	 *
	 * Kept out of `text` because `text` is what an operator reads on a surface, and a JSON blob in
	 * the middle of a sentence is how a channel becomes noise nobody reads.
	 */
	context?: Record<string, unknown>;
}

/** Somewhere a fault can be shown to a person. */
export type FaultSink = (fault: Fault) => void;

/** Removes one attached sink and leaves every other one in place. Safe to call more than once. */
export type DetachFaultSink = () => void;

const attached = new Set<FaultSink>();

/**
 * Point faults at a surface, and get back the handle that removes it again.
 *
 * Called by whoever owns an operator-visible channel, as it builds one. THE CALLER MUST DETACH WHEN
 * ITS SURFACE GOES AWAY: a sink that outlives its session keeps a disposed `OperatorNotices` alive
 * and posts later faults into a channel no longer rendered anywhere, and in tests it collects the
 * next test's faults and reports them against the wrong subject.
 *
 * IDENTITY-KEYED. Attaching the same function object twice attaches it once, and either handle
 * removes it, so a caller that wants two independent registrations passes two closures. This is a
 * `Set` rather than an array because delivering the same fault twice to one surface is noise, and
 * every real caller passes a fresh closure over its own channel.
 */
export function attachFaultSink(sink: FaultSink): DetachFaultSink {
	attached.add(sink);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		attached.delete(sink);
	};
}

/**
 * How many surfaces are listening.
 *
 * For assertions about attach and detach bookkeeping. The sinks themselves are not exposed: handing
 * a caller another surface's sink invites calling it, and a fault belongs to whoever raised it.
 */
export function faultSinkCount(): number {
	return attached.size;
}

/**
 * Report a fault: to the file log always, and to every attached surface.
 *
 * A SINK THAT THROWS DOES NOT BREAK THE CALLER, AND DOES NOT BLOCK THE OTHER SINKS. These are
 * reported from inside filesystem helpers whose whole contract is to carry on, so a broken renderer
 * taking down a directory scan would turn a diagnostic into an outage. Each sink is called in its own
 * `try`, because one surface throwing must not turn every other report into silence. The
 * throw is itself recorded, since a sink that is quietly failing to deliver is the failure this file
 * exists to prevent, one level up.
 *
 * Delivered over a SNAPSHOT of the set: a sink is free to detach itself while handling a fault (a
 * surface that discovers it is disposed does exactly that), and mutating the set mid-iteration would
 * otherwise decide whether the remaining sinks get the report.
 */
export function reportFault(fault: Fault): void {
	logger.warn(`${fault.source}: ${fault.text}`, fault.context ?? {});
	for (const sink of [...attached]) {
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
