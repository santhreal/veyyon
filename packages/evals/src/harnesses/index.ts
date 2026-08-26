import { errorMessage } from "@veyyon/utils";
import { defaultHarnessRegistry, type HarnessRegistry, requireHarness } from "../core/harness-registry";
import type { HarnessAdapter, PreflightVerdict, Variant } from "../core/types";
import { factoryAdapter } from "./adapters/factory";
import { hermesAdapter } from "./adapters/hermes";
import { ompAdapter } from "./adapters/omp";
import { veyyonAdapter } from "./adapters/veyyon";
import type { HarnessPreflightReport, PreflightHarnessesContext } from "./types";

export * from "./adapters/factory";
export * from "./adapters/hermes";
export * from "./adapters/omp";
export * from "./adapters/veyyon";
export * from "./registry";
export * from "./system-comparison";
export * from "./types";

export const builtinHarnesses = [veyyonAdapter, ompAdapter, factoryAdapter, hermesAdapter] as const;

/**
 * Register all built-in harness adapters in the shared harness registry.
 *
 * Registration is explicit and idempotent.
 */
export function registerBuiltinHarnesses(registry?: HarnessRegistry): void {
	const target = registry ?? defaultHarnessRegistry;
	for (const harness of builtinHarnesses) {
		if (!target.has(harness.name)) {
			target.register(harness);
		}
	}
}

// Auto-register on module load
registerBuiltinHarnesses();

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
					harness = requireHarness(harnessName);
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
