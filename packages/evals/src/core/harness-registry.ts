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
