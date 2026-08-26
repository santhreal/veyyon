/**
 * Registry for evaluation suites (EvalSuite).
 *
 * Registries must be populated by explicit registration from an index module,
 * never by a filesystem scan.
 */

import type { EvalSuite } from "./types";

export class SuiteNotFoundError extends Error {
	constructor(name: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown eval suite "${name}". Registered suites: ${formatted}`);
		this.name = "SuiteNotFoundError";
	}
}

export class DuplicateSuiteRegistrationError extends Error {
	constructor(name: string) {
		super(`Eval suite "${name}" is already registered.`);
		this.name = "DuplicateSuiteRegistrationError";
	}
}

export class SuiteRegistry {
	#suites = new Map<string, EvalSuite>();

	register(suite: EvalSuite): void {
		if (this.#suites.has(suite.name)) {
			throw new DuplicateSuiteRegistrationError(suite.name);
		}
		this.#suites.set(suite.name, suite);
	}

	get(name: string): EvalSuite | undefined {
		return this.#suites.get(name);
	}

	has(name: string): boolean {
		return this.#suites.has(name);
	}

	list(): readonly EvalSuite[] {
		return [...this.#suites.values()];
	}

	listNames(): readonly string[] {
		return [...this.#suites.keys()];
	}

	require(name: string): EvalSuite {
		const suite = this.#suites.get(name);
		if (!suite) {
			throw new SuiteNotFoundError(name, this.listNames());
		}
		return suite;
	}

	unregister(name: string): boolean {
		return this.#suites.delete(name);
	}

	clear(): void {
		this.#suites.clear();
	}
}

export const defaultSuiteRegistry = new SuiteRegistry();

export function registerSuite(suite: EvalSuite): void {
	defaultSuiteRegistry.register(suite);
}

export function getSuite(name: string): EvalSuite | undefined {
	return defaultSuiteRegistry.get(name);
}

export function hasSuite(name: string): boolean {
	return defaultSuiteRegistry.has(name);
}

export function listSuites(): readonly EvalSuite[] {
	return defaultSuiteRegistry.list();
}

export function listSuiteNames(): readonly string[] {
	return defaultSuiteRegistry.listNames();
}

export function requireSuite(name: string): EvalSuite {
	return defaultSuiteRegistry.require(name);
}

export function unregisterSuite(name: string): boolean {
	return defaultSuiteRegistry.unregister(name);
}

export function clearSuiteRegistry(): void {
	defaultSuiteRegistry.clear();
}
