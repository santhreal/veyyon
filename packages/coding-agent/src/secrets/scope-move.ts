/**
 * Moving a stored credential from one vault to another, planned before anything is written.
 *
 * A move is an add followed by a remove, and both halves are destructive in the wrong order or
 * against the wrong scope. So the decision is made here, over entries already in hand, and the
 * caller either gets a plan it can execute or a refusal it can print. Nothing in this module
 * touches the filesystem, and nothing in it can see a value: it reasons about names and scopes.
 */
import type { ScopedVaultEntry, VaultScope } from "./vault";

/** A move that has been checked and can be carried out. */
export interface ScopeMovePlan {
	name: string;
	from: VaultScope;
	to: VaultScope;
}

/** Why a move will not run, in the operator's terms. `null` when it will. */
export type ScopeMoveRefusal = string | null;

/**
 * Decide whether an entry can move to `to`, and describe the move or the refusal.
 *
 * PLANNED BEFORE ANYTHING RUNS, and that is the whole point of the function. A move is an add
 * followed by a remove. If the destination already holds the name, the add silently overwrites a
 * different live credential, and the remove that follows then deletes the entry that was being
 * moved: the operator loses two secrets and gains nothing. Discovering the collision partway
 * through, after the remove, is worse still, because by then the credential this move existed to
 * preserve is already gone and cannot be put back. So the collision is looked for here, while both
 * copies are still intact.
 *
 * Pass every entry the caller knows about as `existing`, which for `/secret scope` means every
 * scope's entries. The moving entry may be among them, which is harmless: it sits in the source
 * scope, and only the destination scope is examined.
 *
 * Exactly one side of the result is ever filled in. A non-null refusal always comes with a `null`
 * plan, so a caller cannot read past the refusal and act on a plan anyway.
 */
export function planScopeMove(
	entry: ScopedVaultEntry,
	to: VaultScope,
	existing: readonly ScopedVaultEntry[],
): { plan: ScopeMovePlan | null; refusal: ScopeMoveRefusal } {
	const placeholder = `#${entry.name}#`;
	// A move onto the scope the entry is already in is a no-op that costs one mistyped word. Left to
	// run, it would add over the entry and then remove the name it had just written, destroying the
	// credential to arrive back where it started.
	if (entry.scope === to) {
		return {
			plan: null,
			refusal:
				`${placeholder} is already in the ${to} vault, so there is nothing to move. A move adds to ` +
				`the destination and then removes from the source, and running that pair against one scope ` +
				`would delete the credential it had just written. Pick a different scope.`,
		};
	}
	// Exact name comparison, because that is the test the vault itself applies when it decides
	// whether an add replaces an entry or joins it. Names are uppercased on the way in, so two
	// spellings of one name cannot reach two entries in a single scope.
	//
	// An expired entry still counts. Its name is occupied until that scope's prune runs, and an
	// add landing on it would overwrite a value that may yet be spent. Refusing costs one command.
	const occupied = existing.some(candidate => candidate.scope === to && candidate.name === entry.name);
	if (occupied) {
		return {
			plan: null,
			refusal:
				`The ${to} vault already holds ${placeholder}, and it is a different credential from the ` +
				`${entry.scope} one. Moving would overwrite it and then delete the copy being moved, ` +
				`losing both. Remove it with /secret rm ${entry.name} --scope ${to} first if this one should ` +
				`replace it, then move again.`,
		};
	}
	return { plan: { name: entry.name, from: entry.scope, to }, refusal: null };
}
