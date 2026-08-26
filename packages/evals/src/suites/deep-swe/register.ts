import { defaultSuiteRegistry, type SuiteRegistry } from "../../core/suite-registry";
import { deepSweSuite } from "./suite";

/**
 * Registers the DeepSWE suite in the shared suite registry.
 *
 * Registration is explicit and idempotent.
 */
export function registerDeepSweSuite(registry?: SuiteRegistry): void {
	const target = registry ?? defaultSuiteRegistry;
	if (!target.has(deepSweSuite.name)) {
		target.register(deepSweSuite);
	}
}

// Auto-register on module load
registerDeepSweSuite();
