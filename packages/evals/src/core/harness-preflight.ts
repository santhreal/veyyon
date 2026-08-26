import { errorMessage } from "@veyyon/utils";
import { defaultHarnessRegistry, type HarnessRegistry } from "./harness-registry";
import type { BackendId, HarnessAdapter, PreflightVerdict, Variant } from "./types";

export interface HarnessPreflightReport {
	readonly harness: string;
	readonly variant: string;
	readonly verdict: PreflightVerdict;
}

export interface PreflightHarnessesContext {
	readonly backend: BackendId;
	readonly options?: Readonly<Record<string, unknown>>;
	readonly signal?: AbortSignal;
	readonly harnessRegistry?: HarnessRegistry;
}

/**
 * Run preflight checks for all variants' harnesses.
 *
 * De-duplicates checks per (harness, backend) pair so thousands of cells
 * do not run redundant probes, but returns one report per variant.
 * Fails closed if a variant names an unregistered harness.
 */
export async function preflightHarnesses(
	variants: readonly Variant[],
	context: PreflightHarnessesContext,
): Promise<readonly HarnessPreflightReport[]> {
	const registry = context.harnessRegistry ?? defaultHarnessRegistry;
	const reports: HarnessPreflightReport[] = [];
	const probeCache = new Map<string, Promise<PreflightVerdict>>();

	for (const variant of variants) {
		const harnessName = variant.harness;
		const probeKey = `${harnessName}:${context.backend}`;

		let probePromise = probeCache.get(probeKey);
		if (!probePromise) {
			probePromise = (async (): Promise<PreflightVerdict> => {
				let harness: HarnessAdapter;
				try {
					harness = registry.require(harnessName);
				} catch (err) {
					return {
						ok: false,
						reason: `Unregistered harness "${harnessName}" required by variant "${variant.name}": ${errorMessage(err)}`,
						missingRequirements: [harnessName],
					};
				}
				try {
					return await harness.preflight({
						backend: context.backend,
						options: context.options,
						signal: context.signal,
					});
				} catch (err) {
					return {
						ok: false,
						reason: `Harness "${harnessName}" preflight probe threw an unexpected error: ${errorMessage(err)}`,
						missingRequirements: [harnessName],
					};
				}
			})();
			probeCache.set(probeKey, probePromise);
		}

		const verdict = await probePromise;
		reports.push({
			harness: harnessName,
			variant: variant.name,
			verdict,
		});
	}

	return reports;
}
