/** Registry of owner-scoped resources a session must release when it disposes. `disposeKernelSessionsByOwner`, `disposeRubyKernelSessionsByOwner`, */
import { withTimeout } from "@veyyon/utils/async";
import * as logger from "@veyyon/utils/logger";

/** Which owner id a disposer is keyed by. A session has more than one, and they are not interchangeable. Eval kernels are keyed by the */
export type OwnedResourceScope = "eval-kernel-owner" | "session";

/** One subsystem's owner-scoped cleanup. */
export interface OwnedResourceDisposer {
	/** Which of the session's owner ids {@link dispose} expects. */
	readonly scope: OwnedResourceScope;
	/** Hard ceiling on this subsystem's cleanup, when it can hang. Browser teardown talks to a live CDP connection and a broken close must not stall `/exit`. */
	readonly timeoutMs?: number;
	/** Stable identifier, used in logs and to order disposal deterministically. Order matters only in that it must not depend on module LOAD order, which varies with which */
	readonly name: string;
	/** Release everything owned by `ownerId`. Returns how many resources it released, when the subsystem counts them, so a caller can log */
	// `void` rather than `undefined` on purpose: it is what lets a subsystem that does not count
	// anything implement this as a plain `async dispose(ownerId) { ... }`. `Promise<void>` is not
	// assignable to `Promise<number | undefined>`, so narrowing the union here would force every
	// such implementer to write an explicit `return undefined`.
	// biome-ignore lint/suspicious/noConfusingVoidType: the union is the extension point, see above.
	dispose(ownerId: string): Promise<number | void>;
}

const disposers = new Map<string, OwnedResourceDisposer>();

/** Register a subsystem's cleanup. Call it at module scope, beside the map the resources live in. Re-registering the same name replaces the entry rather than adding a second: a module evaluated */
export function registerOwnedResourceDisposer(disposer: OwnedResourceDisposer): void {
	disposers.set(disposer.name, disposer);
}

/** Every registered name, sorted, across all scopes. Exported for the tests that assert who is wired up. */
export function registeredOwnedResourceDisposers(): string[] {
	return Array.from(disposers.keys()).sort();
}

/** Release every subsystem registered under `scope`, for `ownerId`. Every disposer runs even when an earlier one throws, which is the whole point. Failures are */
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
