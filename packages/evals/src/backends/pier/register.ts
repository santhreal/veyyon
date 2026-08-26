import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { pierBackend } from "./backend";

/**
 * Registers the Pier execution backend in the shared backend registry.
 *
 * Registration is explicit and idempotent.
 */
export function registerPierBackend(registry?: BackendRegistry): void {
	const target = registry ?? defaultBackendRegistry;
	if (!target.has(pierBackend.id)) {
		target.register(pierBackend);
	}
}

// Auto-register on module load
registerPierBackend();
