/**
 * Choosing which `vey` binary a run stages.
 *
 * WHY THIS IS ITS OWN MODULE. Pinning the binary is what makes two days of quota
 * poolable: `--merge` refuses runs whose binary sha differs, and the runner
 * otherwise rebuilds whenever anything under `packages/coding-agent/src` is newer
 * than the binary, which in a shared tree is every day. Getting the pin wrong is
 * silent in the worst way. A run that quietly falls back to the working-tree build
 * stages a different sha, the merge refuses the pair afterwards, and the second day
 * of quota has already been spent on a comparison that cannot be pooled. That is
 * worth a tested contract rather than an inline ternary, and `run.ts` executes its
 * `main()` on import, so the contract cannot be tested where it is used.
 */

import * as path from "node:path";

/** What the flag resolved to, and whether a pin was requested at all. */
export type BinaryPin =
	| { readonly kind: "build" }
	| { readonly kind: "pinned"; readonly path: string }
	| { readonly kind: "invalid"; readonly reason: string };

/**
 * Resolve the `--binary` flag.
 *
 * An ABSENT flag means build from the working tree. That is the default, not a
 * fallback: nothing failed, and nothing needs announcing.
 *
 * An EMPTY flag is an operator mistake and is rejected rather than treated as
 * absent. Silently building from the tree there would be a fallback in exactly the
 * case where a pin was intended, and the cost of it surfaces a day later when the
 * merge refuses.
 *
 * The path is resolved against `cwd` so a run directory can be named relatively,
 * which is how it reads in the docs and how anybody would type it.
 */
export function resolveBinaryPin(flag: string | undefined, cwd: string = process.cwd()): BinaryPin {
	if (flag === undefined) return { kind: "build" };
	const trimmed = flag.trim();
	if (trimmed === "") {
		return {
			kind: "invalid",
			reason: "--binary was given an empty path. Point it at a run's assets/vey, or omit it.",
		};
	}
	return { kind: "pinned", path: path.resolve(cwd, trimmed) };
}
