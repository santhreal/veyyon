import { defaultSuiteRegistry, type SuiteRegistry } from "../../core/suite-registry";
import { terminalBenchSuite } from "./suite";

/**
 * Registers the Terminal-Bench suite in the given (or default) suite registry.
 *
 * Registration is explicit and idempotent per registry.
 */
export function registerTerminalBenchSuite(registry: SuiteRegistry = defaultSuiteRegistry): void {
	if (registry.has(terminalBenchSuite.name)) {
		return;
	}
	registry.register(terminalBenchSuite);
}

// Explicit auto-register on module import
registerTerminalBenchSuite();
