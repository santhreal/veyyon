/**
 * Registry for harness adapters (HarnessAdapter).
 *
 * Registries must be populated by explicit registration from an index module,
 * never by a filesystem scan.
 */

import type { HarnessAdapter } from "./types";

export class HarnessNotFoundError extends Error {
	constructor(name: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown harness adapter "${name}". Registered harnesses: ${formatted}`);
		this.name = "HarnessNotFoundError";
	}
}

export class DuplicateHarnessRegistrationError extends Error {
	constructor(name: string) {
		super(`Harness adapter "${name}" is already registered.`);
		this.name = "DuplicateHarnessRegistrationError";
	}
}

export interface SystemsSelectionValidation {
	readonly valid: boolean;
	readonly selected: readonly string[];
	readonly unknown: readonly string[];
	readonly invalid: readonly string[];
	readonly missing: readonly string[];
	readonly errors: readonly string[];
}

export class HarnessRegistry {
	#harnesses = new Map<string, HarnessAdapter>();

	register(harness: HarnessAdapter): void {
		if (this.#harnesses.has(harness.name)) {
			throw new DuplicateHarnessRegistrationError(harness.name);
		}
		this.#harnesses.set(harness.name, harness);
	}

	get(name: string): HarnessAdapter | undefined {
		return this.#harnesses.get(name);
	}

	has(name: string): boolean {
		return this.#harnesses.has(name);
	}

	list(): readonly HarnessAdapter[] {
		return [...this.#harnesses.values()];
	}

	listNames(): readonly string[] {
		return [...this.#harnesses.keys()];
	}

	require(name: string): HarnessAdapter {
		const harness = this.#harnesses.get(name);
		if (!harness) {
			throw new HarnessNotFoundError(name, this.listNames());
		}
		return harness;
	}

	unregister(name: string): boolean {
		return this.#harnesses.delete(name);
	}

	clear(): void {
		this.#harnesses.clear();
	}

	validateSelection(systems: readonly string[]): SystemsSelectionValidation {
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
			if (this.has(trimmed)) {
				selected.push(trimmed);
			} else {
				unknown.push(trimmed);
			}
		}

		if (unknown.length > 0) {
			const available = [...this.listNames()].sort().join(", ");
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
}

export const defaultHarnessRegistry = new HarnessRegistry();

export function registerHarness(harness: HarnessAdapter): void {
	defaultHarnessRegistry.register(harness);
}

export function getHarness(name: string): HarnessAdapter | undefined {
	return defaultHarnessRegistry.get(name);
}

export function hasHarness(name: string): boolean {
	return defaultHarnessRegistry.has(name);
}

export function listHarnesses(): readonly HarnessAdapter[] {
	return defaultHarnessRegistry.list();
}

export function listHarnessNames(): readonly string[] {
	return defaultHarnessRegistry.listNames();
}

export function requireHarness(name: string): HarnessAdapter {
	return defaultHarnessRegistry.require(name);
}

export function unregisterHarness(name: string): boolean {
	return defaultHarnessRegistry.unregister(name);
}

export function clearHarnessRegistry(): void {
	defaultHarnessRegistry.clear();
}
export function validateSystemsSelection(systems: readonly string[]): SystemsSelectionValidation {
	return defaultHarnessRegistry.validateSelection(systems);
}
