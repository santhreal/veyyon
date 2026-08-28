/** Indirect eval — runs in the host's global scope, isolating bindings declared with `const`/`let` from this module's closure. Used by both the JS eval worker and the */
export function indirectEval(source: string, filename?: string): unknown {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	// Read `eval` via a property access so the call site is *indirect* (global scope),
	// not direct (this module's lexical scope). The cast erases the DOM lib return type.
	// We deliberately avoid `node:vm` because Bun crashes the parent with SIGTRAP when
	// Worker.terminate() fires mid-`vm.runInContext` synchronous loop — indirect eval is
	// the executor for user code in the worker.
	// biome-ignore lint/security/noGlobalEval: see comment above — this is the executor.
	const geval = globalThis.eval as (src: string) => unknown;
	return geval(withPragma);
}

export async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}
