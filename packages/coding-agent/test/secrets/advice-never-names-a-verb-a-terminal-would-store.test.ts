/**
 * Every string that tells an operator how to fix a secrets problem must name a route they can
 * actually take from where they are.
 *
 * WHY THIS SUITE EXISTS. `/secret` has two grammars. In a terminal there are no verbs: everything
 * after `/secret` IS the credential, and the only reserved word is `manager`. A client with no
 * terminal keeps `add`/`list`/`rm`/`extend`/`log`/`discard`, because it has neither a hidden field
 * nor a card to replace them with.
 *
 * The advice strings did not move when the grammar did. An expired placeholder said "Store it
 * again with /secret add NAME --from-env <VAR>"; a nearly-expired one said "Extend it with
 * /secret extend NAME --ttl 7d"; the unreadable-vault notices said to run
 * "/secret discard --scope <scope>". Typed at a terminal prompt, each of those is stored as a
 * credential and reported as a success. The advice meant to rescue the operator would have become
 * the next secret in their vault, under a generated name, with the real one still broken.
 *
 * These emitters cannot know which surface will print them: they are raised by the vault loader
 * and the obfuscator, below any notion of a UI. So the contract is not "use the TUI form", it is
 * that a string naming a VERB form must also name a route that works in a terminal. Both readers
 * are then served by one sentence.
 *
 * The check is a rule rather than a set of golden strings on purpose: the failure mode is a NEW
 * piece of advice added later with the old grammar in mind, and a golden-string test only pins
 * the sentences that already exist.
 */
import { describe, expect, it } from "bun:test";
import { describeSecretExpiry } from "@veyyon/coding-agent/secrets/obfuscator";
import { expiryWarnings } from "@veyyon/coding-agent/secrets/secret-command";
import type { ScopedVaultEntry } from "@veyyon/coding-agent/secrets/vault";
import { generateSecretName } from "@veyyon/coding-agent/secrets/vault";

/**
 * The words that only parse where there is no terminal. `manager` is deliberately absent: it is
 * the one word the terminal grammar reserves, so naming it is the fix, not the defect.
 */
const NO_TERMINAL_VERBS = ["add", "list", "rm", "extend", "log", "discard"] as const;

/** A route an operator at a terminal prompt can actually take. */
const TERMINAL_ROUTES = ["/secret manager", "/secret --from-env"] as const;

/**
 * Advice is safe when it names no verb form at all, or names one alongside a terminal route.
 * Returns the offending verbs so a failure says which word is unreachable, not merely that one is.
 */
function verbsWithoutATerminalRoute(advice: string): string[] {
	const named = NO_TERMINAL_VERBS.filter(verb => advice.includes(`/secret ${verb}`));
	if (named.length === 0) return [];
	if (TERMINAL_ROUTES.some(route => advice.includes(route))) return [];
	return [...named];
}

const DAY = 24 * 60 * 60 * 1000;
const CREATED = 1_700_000_000_000;

function entry(overrides: Partial<ScopedVaultEntry> = {}): ScopedVaultEntry {
	return {
		name: "DEPLOY_KEY",
		value: "ghp_theActualCredential",
		scope: "profile",
		createdAt: CREATED,
		expiresAt: CREATED + DAY,
		...overrides,
	};
}

describe("advice a terminal operator can act on", () => {
	/**
	 * The expiry notice is the likeliest one to be READ AND OBEYED, because it arrives unprompted
	 * mid-session about a credential the operator is relying on right now. Obeying the old wording
	 * stored `/secret add GITHUB_TOKEN --from-env <VAR>` as a credential.
	 */
	it("names a terminal route when it tells you to store an expired secret again", () => {
		for (const persistedCiphertextRemoved of [true, false]) {
			const advice = describeSecretExpiry({ name: "GITHUB_TOKEN", persistedCiphertextRemoved });

			expect(verbsWithoutATerminalRoute(advice)).toEqual([]);
			expect(advice).toContain("/secret --from-env");
		}
	});

	/**
	 * The extend warning fires while the secret still works, which is exactly when the operator has
	 * a reason to act and no reason to doubt the sentence in front of them.
	 */
	it("names a terminal route when it tells you to extend a secret", () => {
		for (const fraction of [0.5, 0.9, 0.99]) {
			const warning = expiryWarnings([entry()], CREATED + DAY * fraction)[0] ?? "";

			expect(warning).not.toBe("");
			expect(verbsWithoutATerminalRoute(warning)).toEqual([]);
			expect(warning).toContain("/secret manager");
		}
	});

	/**
	 * Both surfaces are served by the one sentence, so the verb form has to SURVIVE. A fix that
	 * deleted `/secret extend` in favour of the manager alone would leave an ACP client with a
	 * warning naming a card it cannot open, which is the same defect pointed the other way.
	 */
	it("keeps the verb form for a client that has no manager to open", () => {
		const warning = expiryWarnings([entry({ name: "DEPLOY_KEY" })], CREATED + DAY * 0.95)[0] ?? "";

		expect(warning).toContain("/secret extend DEPLOY_KEY --ttl 7d");
	});

	/**
	 * Reached when name generation has nowhere left to go. It is the one piece of advice with no
	 * verb form worth keeping, because there is no non-interactive command that frees a name
	 * without naming the secret to remove, and the operator does not know which one to name.
	 */
	it("names the manager when it tells you to free up a name", () => {
		const taken = new Set<string>();
		for (let n = 1; n < 10_000; n++) taken.add(`SECRET_${n}`);

		expect(() => generateSecretName(taken)).toThrow(/\/secret manager/);
	});

	/**
	 * The rule itself, proved against text rather than trusted. Without this, a helper that never
	 * matched anything would pass every case above by returning an empty array forever.
	 */
	it("catches a verb standing on its own and clears one paired with a route", () => {
		expect(verbsWithoutATerminalRoute("Run /secret discard --scope profile to repair it.")).toEqual(["discard"]);
		expect(verbsWithoutATerminalRoute("Store it again with /secret add NAME --from-env VAR.")).toEqual(["add"]);
		expect(
			verbsWithoutATerminalRoute("Open /secret manager, or run /secret discard --scope profile without a terminal."),
		).toEqual([]);
		expect(verbsWithoutATerminalRoute("Nothing actionable here.")).toEqual([]);
	});
});
