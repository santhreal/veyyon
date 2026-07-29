/**
 * A refresh must not permanently downgrade a config-regex value to an opaque placeholder.
 *
 * THE BUG THIS LOCKS OUT. `retainRedactionsFrom` carries the PREVIOUS obfuscator's values forward so
 * a credential that has already flowed stays redacted after the vault, cwd, or enablement changes.
 * It carried them forward as redact-only PLAIN mappings, which is right for a value the new
 * configuration no longer declares and wrong for one the new configuration still covers with a
 * regex rule: the retained plain mapping pre-seats the placeholder, and the regex branch's
 * registration is then skipped, so the reverse mapping and the display grant are never installed.
 *
 * The value stays hidden, so nothing leaks and nothing throws. What breaks is RECOVERY: every
 * config-regex value that had already flowed renders as an opaque `#0...#` token for the remainder
 * of the session, on every display and transcript path, and no later refresh can restore it because
 * each refresh retains the same redact-only mapping again. A session that showed the operator a
 * readable value before a cwd change shows them an opaque token afterwards, permanently.
 *
 * IF THIS REGRESSES: display restoration silently stops surviving refreshes. It will not fail a
 * render or a spend, which is exactly why it needs a test rather than a bug report.
 */
import { describe, expect, it } from "bun:test";
import { type SecretEntry, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";

/** Long enough to clear MIN_OBFUSCATABLE_LENGTH, and distinctive enough to spot in output. */
const VALUE = "sk_live_config_regex_value_0001";

/** A vault-plain entry alongside the regex rule, so retain has something it must still carry. */
const VAULT_VALUE = "vault_plain_value_that_is_long_enough";

/**
 * The configuration under test: a config-derived regex rule, which is the ONE combination
 * `mayRestoreForDisplay` grants display restoration to.
 */
function entries(): SecretEntry[] {
	return [
		{ type: "regex", content: VALUE, origin: "config" },
		{ type: "plain", content: VAULT_VALUE, origin: "vault" },
	];
}

describe("a config-regex value across a refresh", () => {
	/** The baseline: before any refresh, the value round-trips and may be shown. */
	it("round-trips and is display-restorable on a fresh obfuscator", () => {
		const first = new SecretObfuscator(entries());
		const placeholder = first.obfuscate(VALUE);

		expect(placeholder).not.toContain(VALUE);
		expect(first.deobfuscate(placeholder)).toBe(VALUE);
		expect(first.isDisplayRestorable(placeholder)).toBe(true);
	});

	/**
	 * THE DEFECT. The refreshed obfuscator mints the same placeholder and must still be able to
	 * reverse it. Asserted on a SECOND obfuscator that retained from a first which had already
	 * obfuscated the value, which is what any real refresh looks like.
	 */
	it("still reverses the placeholder after retaining from a previous obfuscator", () => {
		const first = new SecretObfuscator(entries());
		const placeholder = first.obfuscate(VALUE);

		const second = new SecretObfuscator(entries());
		second.retainRedactionsFrom(first);
		const afterRefresh = second.obfuscate(VALUE);

		expect(afterRefresh).toBe(placeholder);
		expect(second.deobfuscate(afterRefresh)).toBe(VALUE);
	});

	/**
	 * The display grant must survive too, or the value renders opaque for the rest of the session.
	 *
	 * The grant has to attach to the SAME placeholder, which is why the stability assertion leads.
	 * Without it this row passes when retain mints a different placeholder for the value and grants
	 * display on that one, proving a new mapping is restorable while retain has failed the only thing
	 * it exists to do, which is carry the existing mapping forward.
	 */
	it("still permits display restoration after retaining", () => {
		const first = new SecretObfuscator(entries());
		const placeholder = first.obfuscate(VALUE);

		const second = new SecretObfuscator(entries());
		second.retainRedactionsFrom(first);
		const afterRefresh = second.obfuscate(VALUE);

		expect(afterRefresh).toBe(placeholder);
		expect(second.isDisplayRestorable(afterRefresh)).toBe(true);
		expect(second.containsDisplayRestorablePlaceholder(afterRefresh)).toBe(true);
		expect(second.deobfuscateForDisplay(afterRefresh)).toBe(VALUE);
	});

	/**
	 * Adversarial, and the reason the bug is permanent rather than transient: refreshes chain. Each
	 * new obfuscator retains from the last, so a downgrade introduced by one refresh is re-introduced
	 * by every later one.
	 */
	it("survives a chain of refreshes rather than degrading on a later one", () => {
		let current = new SecretObfuscator(entries());
		const placeholder = current.obfuscate(VALUE);

		for (let refresh = 0; refresh < 4; refresh++) {
			const next = new SecretObfuscator(entries());
			next.retainRedactionsFrom(current);
			expect(next.obfuscate(VALUE)).toBe(placeholder);
			current = next;
		}

		expect(current.deobfuscate(placeholder)).toBe(VALUE);
		expect(current.isDisplayRestorable(placeholder)).toBe(true);
	});

	/**
	 * THE NEGATIVE CONTROL ON THE FIX, and the contract retain exists for.
	 *
	 * A value the NEW configuration no longer declares must stay redacted and must NOT become
	 * spendable or showable. Whatever makes the regex case recover must not hand expansion rights
	 * back to a value that was removed, or the fix has traded a silent downgrade for a real leak.
	 */
	it("keeps a value the new configuration dropped redacted but not expandable", () => {
		const first = new SecretObfuscator(entries());
		const placeholder = first.obfuscate(VALUE);

		// The regex rule is gone; only the unrelated vault entry remains.
		const second = new SecretObfuscator([{ type: "plain", content: VAULT_VALUE, origin: "vault" }]);
		second.retainRedactionsFrom(first);

		expect(second.obfuscate(VALUE)).not.toContain(VALUE);
		expect(second.deobfuscate(placeholder)).toBe(placeholder);
		expect(second.isDisplayRestorable(placeholder)).toBe(false);
	});

	/** A vault-plain value must never gain display restoration through retain either. */
	it("does not grant display restoration to a retained vault value", () => {
		const first = new SecretObfuscator(entries());
		const vaultPlaceholder = first.obfuscate(VAULT_VALUE);

		const second = new SecretObfuscator(entries());
		second.retainRedactionsFrom(first);

		expect(second.isDisplayRestorable(vaultPlaceholder)).toBe(false);
		expect(second.deobfuscateForDisplay(vaultPlaceholder)).toBe(vaultPlaceholder);
	});
});
