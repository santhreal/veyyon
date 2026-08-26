/**
 * Extensible registry for DeepSWE benchmark system adapters and harnesses.
 */
import { factoryAdapter } from "./adapters/factory";
import { hermesAdapter } from "./adapters/hermes";
import { ompAdapter } from "./adapters/omp";
import { veyyonAdapter } from "./adapters/veyyon";
import type { SystemAdapter } from "./types";

const REGISTRY = new Map<string, SystemAdapter>();

// Populated on first access rather than at module load. This module sits inside an
// import cycle (a harness adapter reaches into the deep-swe suite, which reaches back
// here), and reading `veyyonAdapter.name` while that module is still initializing
// throws a TDZ ReferenceError that surfaces as an unhandled error between tests.
let builtinsRegistered = false;

function ensureBuiltins(): void {
	if (builtinsRegistered) return;
	builtinsRegistered = true;
	for (const adapter of [veyyonAdapter, factoryAdapter, hermesAdapter, ompAdapter]) {
		REGISTRY.set(adapter.name, adapter);
	}
}

/**
 * Register a custom system adapter in the global registry.
 */
export function registerSystemAdapter(adapter: SystemAdapter): void {
	ensureBuiltins();
	if (REGISTRY.has(adapter.name)) {
		throw new Error(`System adapter "${adapter.name}" is already registered`);
	}
	REGISTRY.set(adapter.name, adapter);
}

/**
 * Look up a registered system adapter by name, or undefined if not found.
 */
export function getSystemAdapter(name: string): SystemAdapter | undefined {
	ensureBuiltins();
	return REGISTRY.get(name);
}

/**
 * Look up a registered system adapter by name, throwing an informative error if not found.
 */
export function requireSystemAdapter(name: string): SystemAdapter {
	ensureBuiltins();
	const adapter = REGISTRY.get(name);
	if (!adapter) {
		const available = Array.from(REGISTRY.keys()).sort().join(", ");
		throw new Error(`unknown system adapter "${name}". Available systems: ${available}`);
	}
	return adapter;
}

/**
 * Check if a system name is registered.
 */
export function isRegisteredSystem(name: string): boolean {
	ensureBuiltins();
	return REGISTRY.has(name);
}

export const hasSystemAdapter = isRegisteredSystem;

/**
 * Get all registered system adapters.
 */
export function getAllSystemAdapters(): readonly SystemAdapter[] {
	ensureBuiltins();
	return Array.from(REGISTRY.values());
}

/**
 * Get all registered system names.
 */
export function getAllRegisteredSystemNames(): readonly string[] {
	ensureBuiltins();
	return Array.from(REGISTRY.keys());
}

export const listSystemAdapters = getAllRegisteredSystemNames;

/**
 * Validate a user-supplied list of system names for comparison.
 */
export function validateSystemsSelection(systems: readonly string[]): {
	readonly valid: boolean;
	readonly selected: readonly string[];
	readonly unknown: readonly string[];
	readonly invalid: readonly string[];
	readonly missing: readonly string[];
	readonly errors: readonly string[];
} {
	const selected: string[] = [];
	const unknown: string[] = [];
	const errors: string[] = [];

	if (systems.length === 0) {
		errors.push("at least one system must be specified for comparison");
		return { valid: false, selected: [], unknown: [], invalid: [], missing: [], errors };
	}

	const seen = new Set<string>();
	for (const name of systems) {
		const trimmed = name.trim();
		if (!trimmed) continue;
		if (seen.has(trimmed)) {
			errors.push(`duplicate system in comparison list: "${trimmed}"`);
			continue;
		}
		seen.add(trimmed);
		if (isRegisteredSystem(trimmed)) {
			selected.push(trimmed);
		} else {
			unknown.push(trimmed);
		}
	}

	if (unknown.length > 0) {
		const available = [...getAllRegisteredSystemNames()].sort().join(", ");
		errors.push(`unknown system(s): ${unknown.join(", ")}. Available systems: ${available}`);
	}

	if (selected.length < 2 && errors.length === 0) {
		errors.push(
			`system comparison requires at least 2 registered systems; got ${selected.length} (${selected.join(", ")})`,
		);
	}

	return {
		valid: errors.length === 0,
		selected,
		unknown,
		invalid: unknown,
		missing: [],
		errors,
	};
}

export const validateSystemSelection = validateSystemsSelection;
