/**
 * Single owner of cell -> variant resolution.
 *
 * WHY: a TrialCell carries the variant NAME only. Before this module every backend
 * re-derived the harness and the model from that string. Pier passed the name straight
 * to harness lookup, so a matrix variant named `veyyon+alpha@google/gemini-3` resolved
 * to no harness at all and fell back to `veyyon_agent:VeyyonAgent` with the binding's
 * extra kwargs dropped and the variant's model ignored. Harbor guessed the agent and
 * the model from the name's punctuation, so the same variant selected the agent
 * `veyyon+alpha`. Both silently ran something other than the plan.
 *
 * The plan's variants are the only authority: `RunContext.options.variants` carries
 * them, resolution is by exact name, and an unknown name fails closed.
 */

import type { BackendId, HarnessAdapter, HarnessBackendBinding, RunContext, TrialCell, Variant } from "./contracts";

export class UnknownCellVariantError extends Error {
	readonly cellVariant: string;
	readonly knownVariants: readonly string[];

	constructor(cellVariant: string, knownVariants: readonly string[]) {
		const known = knownVariants.length > 0 ? knownVariants.join(", ") : "none";
		super(`Trial cell names variant "${cellVariant}", which the run plan does not define. Plan variants: ${known}`);
		this.name = "UnknownCellVariantError";
		this.cellVariant = cellVariant;
		this.knownVariants = [...knownVariants];
	}
}

export class BackendBindingNotFoundError extends Error {
	readonly harnessName: string;
	readonly backend: BackendId;

	constructor(harness: HarnessAdapter, backend: BackendId) {
		const supported = Object.keys(harness.backends);
		const list = supported.length > 0 ? supported.join(", ") : "none";
		super(
			`Harness "${harness.id}" declares no binding for backend "${backend}". Bound backends: ${list}. ` +
				`Add a "${backend}" entry to the harness adapter's backends map, or run this variant on a bound backend.`,
		);
		this.name = "BackendBindingNotFoundError";
		this.harnessName = harness.id;
		this.backend = backend;
	}
}

/**
 * Resolve the plan variant a trial cell belongs to. Throws when the cell names a
 * variant the plan does not define, because every fallback picks a different arm than
 * the matrix asked for and reports the result under the requested arm's name.
 */
export function resolveCellVariant(cell: TrialCell, context: RunContext): Variant {
	const variants = context.options?.variants ?? [];
	const match = variants.find(variant => variant.name === cell.variant);
	if (!match) {
		throw new UnknownCellVariantError(
			cell.variant,
			variants.map(variant => variant.name),
		);
	}
	return match;
}

/**
 * Read the backend-specific binding a harness declares, failing closed when the
 * harness was never wired for that backend.
 */
export function requireBackendBinding(harness: HarnessAdapter, backend: BackendId): HarnessBackendBinding {
	const binding = harness.backends[backend];
	if (!binding) {
		throw new BackendBindingNotFoundError(harness, backend);
	}
	return binding;
}
