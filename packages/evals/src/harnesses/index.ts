import { defaultHarnessRegistry, type HarnessRegistry } from "../core/harness-registry";
import { factoryAdapter } from "./adapters/factory";
import { hermesAdapter } from "./adapters/hermes";
import { ompAdapter } from "./adapters/omp";
import { veyyonAdapter } from "./adapters/veyyon";

export * from "./adapters/factory";
export * from "./adapters/hermes";
export * from "./adapters/omp";
export * from "./adapters/veyyon";
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
