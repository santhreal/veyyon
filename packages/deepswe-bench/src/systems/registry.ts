/**
 * Extensible registry for DeepSWE benchmark system adapters.
 */
import { factoryAdapter } from "./adapters/factory";
import { hermesAdapter } from "./adapters/hermes";
import { ompAdapter } from "./adapters/omp";
import { veyyonAdapter } from "./adapters/veyyon";
import type { SystemAdapter } from "./types";

const REGISTRY = new Map<string, SystemAdapter>();

REGISTRY.set(veyyonAdapter.name, veyyonAdapter);
REGISTRY.set(factoryAdapter.name, factoryAdapter);
REGISTRY.set(hermesAdapter.name, hermesAdapter);
REGISTRY.set(ompAdapter.name, ompAdapter);

/**
 * Register a custom system adapter in the global registry.
 */
export function registerSystemAdapter(adapter: SystemAdapter): void {
	if (!adapter.name || typeof adapter.name !== "string") {
		throw new Error("System adapter must have a valid non-empty string name");
	}
	REGISTRY.set(adapter.name, adapter);
}

/**
 * Look up a registered system adapter by name, or undefined if not found.
 */
export function getSystemAdapter(name: string): SystemAdapter | undefined {
	return REGISTRY.get(name);
}

/**
 * Look up a registered system adapter by name, throwing an informative error if not found.
 */
export function requireSystemAdapter(name: string): SystemAdapter {
	const adapter = REGISTRY.get(name);
	if (!adapter) {
		const available = getAllRegisteredSystemNames().join(", ");
		throw new Error(`Unknown comparison system "${name}". Registered systems are: ${available}`);
	}
	return adapter;
}

/**
 * Check if a system name is registered.
 */
export function isRegisteredSystem(name: string): boolean {
	return REGISTRY.has(name);
}

export const hasSystemAdapter = isRegisteredSystem;

/**
 * Get all registered system adapters.
 */
export function getAllSystemAdapters(): readonly SystemAdapter[] {
	return Array.from(REGISTRY.values());
}

/**
 * Get all registered system names.
 */
export function getAllRegisteredSystemNames(): readonly string[] {
	return Array.from(REGISTRY.keys());
}

export const listSystemAdapters = getAllRegisteredSystemNames;

/**
 * Validate a user-supplied list of system names for comparison.
 */
export function validateSystemsSelection(systems: readonly string[]): {
	valid: boolean;
	invalid: string[];
	duplicates: string[];
	missing: string[];
	error: string | null;
} {
	if (systems.length < 2) {
		return {
			valid: false,
			invalid: [],
			duplicates: [],
			missing: [],
			error: `error: --systems must specify at least 2 distinct systems to compare (got ${systems.length}: ${systems.join(",")})`,
		};
	}

	const seen = new Set<string>();
	const duplicates: string[] = [];
	const invalid: string[] = [];

	for (const name of systems) {
		if (seen.has(name)) {
			duplicates.push(name);
		}
		seen.add(name);

		if (!isRegisteredSystem(name)) {
			invalid.push(name);
		}
	}

	if (invalid.length > 0 || duplicates.length > 0) {
		const available = getAllRegisteredSystemNames().join(", ");
		const errorParts: string[] = [];
		if (invalid.length > 0) {
			errorParts.push(`unknown system(s): ${invalid.join(", ")} (registered: ${available})`);
		}
		if (duplicates.length > 0) {
			errorParts.push(`duplicate system(s): ${duplicates.join(", ")}`);
		}
		return {
			valid: false,
			invalid,
			duplicates,
			missing: [],
			error: `error: invalid --systems selection: ${errorParts.join("; ")}`,
		};
	}

	return {
		valid: true,
		invalid: [],
		duplicates: [],
		missing: [],
		error: null,
	};
}

export const validateSystemSelection = validateSystemsSelection;
