/**
 * Registry for execution backends (ExecutionBackend).
 *
 * Registries must be populated by explicit registration from an index module,
 * never by a filesystem scan.
 */

import type { BackendId, ExecutionBackend } from "./types";

export class BackendNotFoundError extends Error {
	constructor(id: string, available: readonly string[]) {
		const formatted = available.length > 0 ? available.join(", ") : "(none)";
		super(`Unknown execution backend "${id}". Registered backends: ${formatted}`);
		this.name = "BackendNotFoundError";
	}
}

export class DuplicateBackendRegistrationError extends Error {
	constructor(id: string) {
		super(`Execution backend "${id}" is already registered.`);
		this.name = "DuplicateBackendRegistrationError";
	}
}

export class BackendRegistry {
	#backends = new Map<string, ExecutionBackend>();

	register(backend: ExecutionBackend): void {
		if (this.#backends.has(backend.id)) {
			throw new DuplicateBackendRegistrationError(backend.id);
		}
		this.#backends.set(backend.id, backend);
	}

	get(id: BackendId): ExecutionBackend | undefined {
		return this.#backends.get(id);
	}

	has(id: BackendId): boolean {
		return this.#backends.has(id);
	}

	list(): readonly ExecutionBackend[] {
		return [...this.#backends.values()];
	}

	listIds(): readonly BackendId[] {
		return [...this.#backends.keys()];
	}

	require(id: BackendId): ExecutionBackend {
		const backend = this.#backends.get(id);
		if (!backend) {
			throw new BackendNotFoundError(id, this.listIds());
		}
		return backend;
	}

	unregister(id: BackendId): boolean {
		return this.#backends.delete(id);
	}

	clear(): void {
		this.#backends.clear();
	}
}

export const defaultBackendRegistry = new BackendRegistry();

export function registerBackend(backend: ExecutionBackend): void {
	defaultBackendRegistry.register(backend);
}

export function getBackend(id: BackendId): ExecutionBackend | undefined {
	return defaultBackendRegistry.get(id);
}

export function hasBackend(id: BackendId): boolean {
	return defaultBackendRegistry.has(id);
}

export function listBackends(): readonly ExecutionBackend[] {
	return defaultBackendRegistry.list();
}

export function listBackendIds(): readonly BackendId[] {
	return defaultBackendRegistry.listIds();
}

export function requireBackend(id: BackendId): ExecutionBackend {
	return defaultBackendRegistry.require(id);
}

export function unregisterBackend(id: BackendId): boolean {
	return defaultBackendRegistry.unregister(id);
}

export function clearBackendRegistry(): void {
	defaultBackendRegistry.clear();
}
