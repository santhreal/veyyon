/**
 * The scope-move planner.
 *
 * WHY THIS SUITE EXISTS. A move is an add into one scope and a remove from another, and the two
 * are separately destructive. Run in the wrong order, or run at all when the destination already
 * holds the name, the pair deletes one credential to overwrite a second and leaves the operator
 * with neither. There is no undo: the vault stores a value once and never shows it again, so a
 * secret lost to a bad move is lost from the product entirely.
 *
 * Every test below therefore pins an exact string, an exact scope pair, or an exact absence. The
 * refusals are the feature, not the guard rails around it, so they are asserted verbatim rather
 * than by shape. The last suite exists because the planner handles an entry that carries a live
 * credential, and a planner that leaks one has broken the vault's central promise no matter how
 * correctly it plans.
 */
import { describe, expect, it } from "bun:test";
import { describeScopeMove, nextScope, planScopeMove } from "@veyyon/coding-agent/modes/components/secret-scope-move";
import { type ScopedVaultEntry, VAULT_SCOPES, type VaultScope } from "@veyyon/coding-agent/secrets/vault";

/** Fixed, so `createdAt` and `expiresAt` never vary the assertions. */
const NOW = Date.parse("2026-07-31T12:00:00Z");

/** The one value string every test scans the output for. Distinctive enough to grep with. */
const SECRET_VALUE = "ghp_liveCredentialThatMustNeverBeRendered";

function entryIn(scope: VaultScope, name = "GITHUB_TOKEN", value = SECRET_VALUE): ScopedVaultEntry {
	return { name, value, scope, createdAt: NOW - 60_000, expiresAt: NOW + 3_600_000 };
}

/** Every ordered pair of distinct scopes, which is what a clean move has to work for. */
const SCOPE_PAIRS: readonly (readonly [VaultScope, VaultScope])[] = VAULT_SCOPES.flatMap(from =>
	VAULT_SCOPES.filter(to => to !== from).map(to => [from, to] as const),
);

describe("planScopeMove on a destination that is free", () => {
	/**
	 * Locks out a planner that only handles the pair it was written against. There are six ordered
	 * scope pairs, and a planner that hard-codes one direction, or that copies the source scope
	 * into `to`, would still pass a single-pair test while sending the add to the wrong vault.
	 */
	it("plans the move for every ordered pair of distinct scopes", () => {
		expect(SCOPE_PAIRS.length).toBe(6);
		for (const [from, to] of SCOPE_PAIRS) {
			const { plan, refusal } = planScopeMove(entryIn(from), to, [entryIn(from)]);
			expect(refusal).toBeNull();
			expect(plan).toEqual({ name: "GITHUB_TOKEN", from, to });
		}
	});

	/**
	 * Locks out a collision check that matches on the name alone. The same name living in another
	 * scope is the normal state of a vault, since the narrowest scope wins a clash on purpose, and
	 * refusing on it would make the feature unusable exactly where it is most needed.
	 */
	it("allows the move when the same name exists in a scope that is not the destination", () => {
		const moving = entryIn("project");
		const elsewhere = entryIn("global");
		const { plan, refusal } = planScopeMove(moving, "profile", [moving, elsewhere]);
		expect(refusal).toBeNull();
		expect(plan).toEqual({ name: "GITHUB_TOKEN", from: "project", to: "profile" });
	});

	/**
	 * Locks out a check that compares names case-insensitively or after trimming. The vault
	 * uppercases a name before storing it and compares exact strings when deciding whether an add
	 * replaces an entry, so a planner that is fuzzier than the vault refuses moves the vault would
	 * have performed safely.
	 */
	it("does not treat a differently spelled name in the destination as a collision", () => {
		const moving = entryIn("project", "GITHUB_TOKEN");
		const neighbour = entryIn("profile", "GITHUB_TOKEN_OLD");
		const { plan, refusal } = planScopeMove(moving, "profile", [moving, neighbour]);
		expect(refusal).toBeNull();
		expect(plan).toEqual({ name: "GITHUB_TOKEN", from: "project", to: "profile" });
	});

	/**
	 * Locks out a plan that carries the entry's other fields through. The plan is handed to the
	 * confirmation line and to the container, and anything on it beyond a name and two scopes is
	 * one field away from being rendered.
	 */
	it("puts nothing on the plan except the name and the two scopes", () => {
		const { plan } = planScopeMove(entryIn("global"), "project", []);
		expect(plan).not.toBeNull();
		expect(Object.keys(plan ?? {}).sort()).toEqual(["from", "name", "to"]);
	});
});

describe("planScopeMove refusing a move to the scope the entry is in", () => {
	/**
	 * Locks out the no-op move. Destination is chosen by cycling a key, so pressing it three times
	 * lands back on the source. Allowed to run, the add would write over the entry and the remove
	 * that follows would delete the name it had just written, destroying the credential in exchange
	 * for no change at all.
	 */
	it("refuses with an exact sentence and no plan", () => {
		const { plan, refusal } = planScopeMove(entryIn("profile"), "profile", [entryIn("profile")]);
		expect(plan).toBeNull();
		expect(refusal).toBe(
			"#GITHUB_TOKEN# is already in the profile vault, so there is nothing to move. A move adds to " +
				"the destination and then removes from the source, and running that pair against one scope " +
				"would delete the credential it had just written. Pick a different scope.",
		);
	});

	/**
	 * Locks out a same-scope check that runs after the collision check. The entry is always present
	 * in the card's own row list, so a collision check that ran first would find the entry itself
	 * and report a name clash against a credential that does not exist.
	 */
	it("reports the no-op rather than a collision when the entry itself is in the list", () => {
		const moving = entryIn("global");
		const { plan, refusal } = planScopeMove(moving, "global", [moving]);
		expect(plan).toBeNull();
		expect(refusal).toContain("there is nothing to move");
		expect(refusal).not.toContain("already holds");
	});
});

describe("planScopeMove refusing a name collision in the destination", () => {
	/**
	 * Locks out the two-secret loss. Without this check the add overwrites the destination's live
	 * credential and the remove then deletes the source copy, so the operator ends with neither.
	 * The sentence has to name both scopes, because the operator is looking at one row and cannot
	 * otherwise tell which of the two copies the message is about.
	 */
	it("refuses with an exact sentence naming both scopes and the fix", () => {
		const moving = entryIn("project");
		const occupant = entryIn("profile", "GITHUB_TOKEN", "a-different-live-credential");
		const { plan, refusal } = planScopeMove(moving, "profile", [moving, occupant]);
		expect(plan).toBeNull();
		expect(refusal).toBe(
			"The profile vault already holds #GITHUB_TOKEN#, and it is a different credential from the " +
				"project one. Moving would overwrite it and then delete the copy being moved, losing both. " +
				"Revoke #GITHUB_TOKEN# from the profile vault first if this one should replace it, then " +
				"move again.",
		);
	});

	/**
	 * Locks out a refusal written against one direction. The scopes are interpolated, so a message
	 * that hard-coded either end would read backwards half the time and send the operator to revoke
	 * the copy they are trying to keep.
	 */
	it("names the scopes the right way round in the other direction", () => {
		const moving = entryIn("global", "DEPLOY_KEY");
		const occupant = entryIn("project", "DEPLOY_KEY", "another-credential");
		const { refusal } = planScopeMove(moving, "project", [moving, occupant]);
		expect(refusal).toContain("The project vault already holds #DEPLOY_KEY#");
		expect(refusal).toContain("a different credential from the global one");
		expect(refusal).toContain("Revoke #DEPLOY_KEY# from the project vault first");
	});

	/**
	 * Locks out skipping an expired occupant. An expired entry holds its name until that scope's
	 * prune runs, so the add would still land on top of it, and its value is still spendable by
	 * anything that read the vault before the expiry took effect.
	 */
	it("refuses when the destination's entry of that name has already expired", () => {
		const moving = entryIn("project");
		const stale: ScopedVaultEntry = {
			name: "GITHUB_TOKEN",
			value: "expired-but-still-stored",
			scope: "profile",
			createdAt: NOW - 7_200_000,
			expiresAt: NOW - 1,
		};
		const { plan, refusal } = planScopeMove(moving, "profile", [moving, stale]);
		expect(plan).toBeNull();
		expect(refusal).toContain("The profile vault already holds #GITHUB_TOKEN#");
	});

	/**
	 * Locks out a refusal that is returned alongside a usable plan. A caller that reads `plan`
	 * first would run the add and the remove with the warning sitting unread in the other field,
	 * which is the exact failure the refusal exists to prevent.
	 */
	it("never returns a plan and a refusal together", () => {
		const moving = entryIn("project");
		const occupant = entryIn("profile", "GITHUB_TOKEN", "another-credential");
		for (const result of [
			planScopeMove(moving, "profile", [moving, occupant]),
			planScopeMove(moving, "project", [moving]),
			planScopeMove(moving, "global", [moving]),
		]) {
			expect(result.plan === null).toBe(result.refusal !== null);
		}
	});
});

describe("describeScopeMove", () => {
	/**
	 * Locks out a confirmation that omits an end of the move. The destination is picked by cycling
	 * a key with no picker on screen, so a line reading "Move #GITHUB_TOKEN#" gives the operator
	 * nothing to check the cycle against before they approve a destructive pair of writes.
	 */
	it("names the placeholder and both vaults in one sentence", () => {
		expect(describeScopeMove({ name: "GITHUB_TOKEN", from: "project", to: "profile" })).toBe(
			"Move #GITHUB_TOKEN# from the project vault to the profile vault.",
		);
	});

	/**
	 * Locks out a from/to swap in the sentence. Both ends are scope names of the same shape, so a
	 * transposition reads perfectly and tells the operator the move runs the other way.
	 */
	it("puts the source before the destination in the other direction too", () => {
		expect(describeScopeMove({ name: "DEPLOY_KEY", from: "global", to: "project" })).toBe(
			"Move #DEPLOY_KEY# from the global vault to the project vault.",
		);
	});

	/**
	 * Locks out a raw name where a placeholder belongs. The operator writes `#NAME#` into prompts
	 * and sees `#NAME#` in every row of the table, and a confirmation that drops the hashes reads
	 * as a different identifier from the one being moved.
	 */
	it("wraps the name as a placeholder rather than printing it bare", () => {
		const line = describeScopeMove({ name: "API_KEY_ONE", from: "profile", to: "global" });
		expect(line).toContain("#API_KEY_ONE#");
	});
});

describe("nextScope", () => {
	/**
	 * Locks out a cycle that stalls or skips. The key is the only way to choose a destination, so a
	 * scope missing from the cycle is a scope no one can move a secret into, and a cycle that does
	 * not wrap strands the operator on the last one.
	 */
	it("walks every scope in vault order and wraps back to the first", () => {
		expect([...VAULT_SCOPES]).toEqual(["global", "profile", "project"]);
		expect(nextScope("global")).toBe("profile");
		expect(nextScope("profile")).toBe("project");
		expect(nextScope("project")).toBe("global");
	});

	/**
	 * Locks out a cycle that visits a scope twice or drops one. Walking the length of the list must
	 * touch each scope exactly once and land where it started, which a naive clamp would not do.
	 */
	it("returns to the starting scope after one full lap and visits each scope once", () => {
		let current: VaultScope = "profile";
		const visited: VaultScope[] = [];
		for (let step = 0; step < VAULT_SCOPES.length; step += 1) {
			current = nextScope(current);
			visited.push(current);
		}
		expect(visited).toEqual(["project", "global", "profile"]);
		expect(current).toBe("profile");
	});
});

describe("secret values never reach the planner's output", () => {
	/**
	 * Locks out the one defect that would make this module unshippable. `ScopedVaultEntry` carries
	 * the credential, so every string built here is a place it could be interpolated by accident,
	 * for example by a refusal that tried to show what would be overwritten.
	 */
	it("keeps the value out of a plan, a confirmation line and both refusals", () => {
		const moving = entryIn("project");
		const occupant = entryIn("profile", "GITHUB_TOKEN", "second-live-credential");

		const clean = planScopeMove(moving, "global", [moving, occupant]);
		expect(clean.plan).not.toBeNull();
		const line = clean.plan === null ? "" : describeScopeMove(clean.plan);
		const collision = planScopeMove(moving, "profile", [moving, occupant]);
		const noop = planScopeMove(moving, "project", [moving]);

		const emitted = [JSON.stringify(clean.plan), line, collision.refusal ?? "", noop.refusal ?? ""].join("\n");
		expect(emitted).not.toContain(SECRET_VALUE);
		expect(emitted).not.toContain("second-live-credential");
		expect(emitted).not.toContain("ghp_");
	});

	/**
	 * Locks out a value that survives into the output because it happens to look harmless. A value
	 * equal to its own name, or to a scope, would slip past a substring scan of the previous test,
	 * so the plan's fields are pinned to exactly the three the contract allows.
	 */
	it("builds the plan from the entry's name and scope only, whatever the value is", () => {
		const entry: ScopedVaultEntry = {
			name: "TRICKY_NAME",
			value: "profile",
			scope: "global",
			createdAt: NOW,
			expiresAt: null,
		};
		const { plan } = planScopeMove(entry, "project", [entry]);
		expect(plan).toEqual({ name: "TRICKY_NAME", from: "global", to: "project" });
	});
});
