/**
 * Registry of owner-scoped resources a session must release when it disposes.
 *
 * WHY THIS EXISTS. `agent-session.dispose()` used to name every subsystem by hand:
 * `disposeKernelSessionsByOwner`, `disposeRubyKernelSessionsByOwner`,
 * `disposeJuliaKernelSessionsByOwner`, `disposeVmContextsByOwner`. Two problems, one of them a
 * bug.
 *
 * The bug: those four calls were bare `await`s in sequence, so the FIRST one to throw skipped
 * every later one. A Python kernel that refused to close therefore leaked the Ruby kernels, the
 * Julia kernels, the JS eval contexts and the browser tabs behind it, and the operator saw one
 * error rather than four leaks. Disposal is exactly the path where one failure must not cancel
 * the rest.
 *
 * The design problem: adding a language meant editing a 17,000-line session class, and the
 * session imported four eval executors to call four one-line functions, dragging their whole
 * subsystems into its module graph.
 *
 * REGISTRATION IS LOAD-TIME, AND THAT IS CORRECT HERE, not a silent fallback. A disposer only
 * registers when its module loads, and a subsystem's module only loads when something uses it.
 * There cannot be a Ruby kernel to release unless `eval/rb/executor` was loaded to create it. So
 * "not registered" and "nothing to release" are the same state, always. Do NOT register a
 * subsystem whose resources can be created by a DIFFERENT module than the one holding the
 * disposer: that assumption is what makes this safe, and breaking it makes a leak invisible.
 */
// Owners, not the `@veyyon/utils` barrel: 2 modules against 81.
import { withTimeout } from "@veyyon/utils/async";
import * as logger from "@veyyon/utils/logger";

/**
 * Which owner id a disposer is keyed by.
 *
 * A session has more than one, and they are not interchangeable. Eval kernels are keyed by the
 * session's EVAL-KERNEL owner id, which survives a session handing ownership on; browser tabs are
 * keyed by the session id itself, assigned at `acquireTab` creation and never on reuse. Releasing
 * one subsystem with the other's id matches nothing and silently leaks, so the scope is declared
 * rather than inferred.
 */
export type OwnedResourceScope = "eval-kernel-owner" | "session";

/** One subsystem's owner-scoped cleanup. */
export interface OwnedResourceDisposer {
	/** Which of the session's owner ids {@link dispose} expects. */
	readonly scope: OwnedResourceScope;
	/**
	 * Hard ceiling on this subsystem's cleanup, when it can hang.
	 *
	 * Browser teardown talks to a live CDP connection and a broken close must not stall `/exit`.
	 * Omit it when the work is local bookkeeping that cannot block.
	 */
	readonly timeoutMs?: number;
	/**
	 * Stable identifier, used in logs and to order disposal deterministically.
	 *
	 * Order matters only in that it must not depend on module LOAD order, which varies with which
	 * tools a session happened to use. Sorting by name gives the same sequence every run.
	 */
	readonly name: string;
	/**
	 * Release everything owned by `ownerId`.
	 *
	 * Returns how many resources it released, when the subsystem counts them, so a caller can log
	 * something more useful than "done". Returning nothing is fine.
	 */
	// `void` rather than `undefined` on purpose: it is what lets a subsystem that does not count
	// anything implement this as a plain `async dispose(ownerId) { ... }`. `Promise<void>` is not
	// assignable to `Promise<number | undefined>`, so narrowing the union here would force every
	// such implementer to write an explicit `return undefined`.
	// biome-ignore lint/suspicious/noConfusingVoidType: the union is the extension point, see above.
	dispose(ownerId: string): Promise<number | void>;
}

const disposers = new Map<string, OwnedResourceDisposer>();

/**
 * Register a subsystem's cleanup. Call it at module scope, beside the map the resources live in.
 *
 * Re-registering the same name replaces the entry rather than adding a second: a module evaluated
 * twice (test isolation, a re-import through a different specifier) must not dispose twice.
 */
export function registerOwnedResourceDisposer(disposer: OwnedResourceDisposer): void {
	disposers.set(disposer.name, disposer);
}

/** Every registered name, sorted, across all scopes. Exported for the tests that assert who is wired up. */
export function registeredOwnedResourceDisposers(): string[] {
	return [...disposers.keys()].sort();
}

/**
 * Release every subsystem registered under `scope`, for `ownerId`.
 *
 * Every disposer runs even when an earlier one throws, which is the whole point. Failures are
 * logged as they happen and then rethrown together as an `AggregateError`, so a caller still
 * learns that cleanup did not fully succeed instead of a failure being swallowed.
 *
 * @throws AggregateError if any disposer threw, after all of them have run.
 */
export async function disposeOwnedResources(scope: OwnedResourceScope, ownerId: string): Promise<void> {
	const failures: Error[] = [];
	for (const name of registeredOwnedResourceDisposers()) {
		const disposer = disposers.get(name);
		if (!disposer || disposer.scope !== scope) continue;
		try {
			const work = disposer.dispose(ownerId);
			const released = disposer.timeoutMs
				? await withTimeout(work, disposer.timeoutMs, `Timed out releasing ${name} during dispose`)
				: await work;
			if (typeof released === "number" && released > 0) {
				logger.debug("Released owner-scoped resources during dispose", { subsystem: name, ownerId, released });
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			logger.warn("Failed to release owner-scoped resources during dispose", {
				subsystem: name,
				ownerId,
				error: failure.message,
			});
			failures.push(failure);
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, `Failed to release owner-scoped resources for ${ownerId}`);
	}
}
