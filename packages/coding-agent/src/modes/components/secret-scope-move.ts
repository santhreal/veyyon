/**
 * Moving a stored credential from one scope to another.
 *
 * The vault has always been able to express this as an add into the destination plus a remove from
 * the source, but nothing in the product offered it. A secret put in the wrong scope therefore had
 * to be revoked and typed in again from wherever it originally came from, which for a token you
 * only ever see once is not a recovery, it is a re-issue.
 *
 * The move is planned here rather than performed here. This module never opens a vault, never
 * writes a file, and never reads a value: it takes the entry, the destination and the scopes the
 * card already has in memory, and returns either a description of what would happen or a sentence
 * saying why it will not. The container runs the add and the remove, because a mutation belongs in
 * one place, and because a pure planner is what lets the refusals be tested against exact text.
 *
 * Nothing built here carries the credential. {@link ScopeMovePlan} holds a name and two scopes, and
 * every string returned is assembled from those three fields, so neither a refusal nor a
 * confirmation line can put a value on screen or into a log.
 */
import { buildNamePlaceholder } from "../../secrets/placeholder";
import { type ScopedVaultEntry, VAULT_SCOPES, type VaultScope } from "../../secrets/vault";
import type { ScopeMovePlan, ScopeMoveRefusal } from "./secret-manager-types";

/**
 * Decide whether an entry can move to `to`, and describe the move or the refusal.
 *
 * PLANNED BEFORE ANYTHING RUNS, and that is the whole point of the function. A move is an add
 * followed by a remove. If the destination already holds the name, the add silently overwrites a
 * different live credential, and the remove that follows then deletes the entry that was being
 * moved: the operator loses two secrets and gains nothing. Discovering the collision partway
 * through, after the remove, is worse still, because by then the credential this move existed to
 * preserve is already gone and cannot be put back. So the collision is looked for here, against
 * the entries the card has already loaded, while both copies are still intact.
 *
 * Pass every entry the card knows about as `existing`. The moving entry may be among them, which
 * is harmless: it sits in the source scope, and only the destination scope is examined.
 *
 * Exactly one side of the result is ever filled in. A non-null refusal always comes with a `null`
 * plan, so a caller cannot read past the refusal and act on a plan anyway.
 */
export function planScopeMove(
	entry: ScopedVaultEntry,
	to: VaultScope,
	existing: readonly ScopedVaultEntry[],
): { plan: ScopeMovePlan | null; refusal: ScopeMoveRefusal } {
	const placeholder = buildNamePlaceholder(entry.name);
	// A move onto the scope the entry is already in is a no-op the operator can reach by pressing
	// the cycle key one time too many. Left to run, it would add over the entry and then remove
	// the name it just wrote, destroying the credential to arrive back where it started.
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
	// add landing on it would overwrite a value that may yet be spent. Refusing costs one keypress.
	const occupied = existing.some(candidate => candidate.scope === to && candidate.name === entry.name);
	if (occupied) {
		return {
			plan: null,
			refusal:
				`The ${to} vault already holds ${placeholder}, and it is a different credential from the ` +
				`${entry.scope} one. Moving would overwrite it and then delete the copy being moved, ` +
				`losing both. Revoke ${placeholder} from the ${to} vault first if this one should replace ` +
				`it, then move again.`,
		};
	}
	return { plan: { name: entry.name, from: entry.scope, to }, refusal: null };
}

/**
 * The one line an operator reads before a move runs.
 *
 * A confirmation has to name the credential and both ends of the move, because the destination is
 * chosen by cycling a key and the scope that ends up selected is easy to lose track of. It is built
 * from the plan alone, which is how it stays incapable of printing the value.
 */
export function describeScopeMove(plan: ScopeMovePlan): string {
	return `Move ${buildNamePlaceholder(plan.name)} from the ${plan.from} vault to the ${plan.to} vault.`;
}

/**
 * The next scope in the cycle a key press walks through.
 *
 * Choosing a destination is a single key that advances through {@link VAULT_SCOPES} and wraps, so
 * there is no separate picker to open and no way to land on a scope that does not exist. The order
 * is the vault's own, widest first, which is the order the scopes are already listed in everywhere
 * else the operator sees them.
 */
export function nextScope(current: VaultScope): VaultScope {
	const index = VAULT_SCOPES.indexOf(current);
	// An unrecognised scope cannot come from the type, but it can come from a vault file that was
	// edited by hand. Starting the cycle at the first scope keeps the key working either way.
	return VAULT_SCOPES[(index + 1) % VAULT_SCOPES.length];
}
