import { withTimeout } from "@veyyon/utils/async";
import * as logger from "@veyyon/utils/logger";

export type OwnedResourceScope = "eval-kernel-owner" | "session";

export interface OwnedResourceDisposer {
	readonly scope: OwnedResourceScope;
	readonly timeoutMs?: number;
	readonly name: string;
	// biome-ignore lint/suspicious/noConfusingVoidType: the union is the extension point, see above.
	dispose(ownerId: string): Promise<number | void>;
}

const disposers = new Map<string, OwnedResourceDisposer>();

export function registerOwnedResourceDisposer(disposer: OwnedResourceDisposer): void {
	disposers.set(disposer.name, disposer);
}

export function registeredOwnedResourceDisposers(): string[] {
	return Array.from(disposers.keys()).sort();
}

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
