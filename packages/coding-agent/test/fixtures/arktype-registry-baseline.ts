/**
 * Evaluates ArkType and records its global node registry before any product module builds a schema.
 * Import it for its side effect right after `arktype-jitless` and before any product module, so the
 * record is taken between ArkType's own evaluation and the product's.
 */
import "arktype";

type RegisteredNode = { kind?: unknown; expression?: unknown };

const registry = (globalThis as unknown as { $ark: { nodesByRegisteredId: Record<string, RegisteredNode> } }).$ark
	.nodesByRegisteredId;

/** Nodes in `$ark.nodesByRegisteredId` now. */
export function registeredNodes(): number {
	return Object.keys(registry).length;
}

/** The ids of every registered node now. */
export function registeredIds(): ReadonlySet<string> {
	return new Set(Object.keys(registry));
}

/**
 * The kind and expression of every node registered since `before`, sorted and deduplicated, for a
 * failure message that states which schema was built.
 */
export function registeredSince(before: ReadonlySet<string>): string[] {
	const expressions = new Set<string>();
	for (const [id, node] of Object.entries(registry)) {
		if (before.has(id)) continue;
		expressions.add(`${String(node?.kind ?? "context")} ${String(node?.expression ?? "").slice(0, 160)}`);
	}
	return [...expressions].sort();
}

/** Node ids ArkType registered for itself, before any product module evaluated. */
export const baselineIds = registeredIds();
