/**
 * Every string that tells an operator how to fix a secrets problem must name a command the surface
 * reading it would RUN, never one it would store as a credential.
 *
 * WHY THIS SUITE EXISTS. `/secret` takes a command first, so advice that names `/secret revoke NAME`
 * hands the operator a line that does not run: the first word is not a verb, the command refuses,
 * and the real problem is exactly where it was. The advice meant to rescue them costs them a round
 * trip and their confidence in the rest of the message.
 *
 * IT USED TO BE WORSE, which is why the rule is enforced mechanically rather than by review. A
 * terminal read any unreserved first word as the credential itself, so this advice did not fail
 * loudly: it stored the string `revoke NAME` as a secret under a generated name, reported success,
 * and the sentence written to rescue the operator became the next entry in their vault.
 *
 * These emitters cannot know which surface will print them: they are raised by the vault loader and
 * the obfuscator, below any notion of a UI. So the contract is not "use the terminal form", it is
 * that every word an advice string puts after `/secret` is a word BOTH surfaces parse as a command.
 *
 * THE CHECK IS A RULE, NOT A SET OF GOLDEN STRINGS, and the reserved set is asked of the parser at
 * run time rather than listed here. The failure mode is a new piece of advice, or a new verb, added
 * later with a stale idea of the grammar, and a golden-string test only pins the sentences that
 * already exist.
 *
 * WHAT IT DOES NOT CATCH. Advice that names a real verb with the wrong arguments (`/secret extend`
 * with no `--ttl`) reads as runnable here, because the first word does parse; the refusal an
 * operator gets in that case names the missing option rather than storing anything, which is the
 * property this suite is about. Notices raised through `noteSecretsCondition` inside the vault
 * loader are covered by the suites that drive a broken vault end to end.
 */
import { describe, expect, it } from "bun:test";
import { describeSecretExpiry } from "@veyyon/coding-agent/secrets/obfuscator";
import type { SecretCommandSurface } from "@veyyon/coding-agent/secrets/secret-command";
import {
	expiryWarnings,
	parseSecretCommand,
	SECRET_TUI_SUBCOMMANDS,
} from "@veyyon/coding-agent/secrets/secret-command";
import type { ScopedVaultEntry } from "@veyyon/coding-agent/secrets/vault";
import { generateSecretName } from "@veyyon/coding-agent/secrets/vault";

const SURFACES: readonly SecretCommandSurface[] = ["tui", "noninteractive"];

/** Every word an advice string puts directly after `/secret`, flags included. */
function wordsAdvertised(advice: string): string[] {
	return [...advice.matchAll(/\/secret\s+(--?[a-z][\w-]*|[A-Za-z][\w-]*)/g)].map(match => match[1]);
}

/**
 * Whether this surface would RUN `/secret <word>` rather than store it or reject it as unknown.
 *
 * Asked of the real parser so the reserved set cannot go stale: adding a verb makes it safe to
 * advertise the moment it parses, and removing one makes every string naming it fail here.
 */
function isRunnableWord(word: string, surface: SecretCommandSurface): boolean {
	// An option is never the first word, so it cannot collide with a credential.
	if (word.startsWith("-")) return true;
	try {
		// A parse that captured the word as the credential means this surface would STORE the advice.
		return parseSecretCommand(word, surface).value === undefined;
	} catch (error) {
		// A refusal is fine, and is what a verb missing its arguments does. Being called UNKNOWN is
		// not: nothing runs at all, and the operator is told the fix they were handed does not exist.
		const message = error instanceof Error ? error.message : String(error);
		return !message.includes("Unknown /secret command");
	}
}

/**
 * The words in this advice that some surface would not run, each tagged with the surface that
 * refuses it, so a failure says which word is unreachable from where and not merely that one is.
 */
function unrunnableWords(advice: string): string[] {
	const offences: string[] = [];
	for (const word of wordsAdvertised(advice)) {
		for (const surface of SURFACES) {
			if (!isRunnableWord(word, surface)) offences.push(`${word} (${surface})`);
		}
	}
	return offences;
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

describe("advice an operator can act on from where they are", () => {
	/**
	 * The expiry notice is the likeliest one to be READ AND OBEYED, because it arrives unprompted
	 * mid-session about a credential the operator is relying on right now.
	 */
	it("names only runnable commands when it tells you to store an expired secret again", () => {
		for (const persistedCiphertextRemoved of [true, false]) {
			const advice = describeSecretExpiry({ name: "GITHUB_TOKEN", persistedCiphertextRemoved });

			expect(unrunnableWords(advice)).toEqual([]);
			// The terminal form it names has to be the one the parser now reads: a `/secret --from-env`
			// with no verb in front of it is refused, so advice that spelled it that way would send the
			// operator into the refusal while a credential they depend on is already dead.
			expect(advice).toContain("/secret add --from-env");
		}
	});

	/**
	 * The extend warning fires while the secret still works, which is exactly when the operator has
	 * a reason to act and no reason to doubt the sentence in front of them.
	 */
	it("names only runnable commands when it tells you to extend a secret", () => {
		for (const fraction of [0.5, 0.9, 0.99]) {
			const warning = expiryWarnings([entry()], CREATED + DAY * fraction)[0] ?? "";

			expect(warning).not.toBe("");
			expect(unrunnableWords(warning)).toEqual([]);
		}
	});

	/**
	 * ONE SENTENCE SERVES BOTH SURFACES, so the verb form has to survive. A remedy that named a
	 * screen instead would leave a client with no terminal holding advice it cannot take, which is
	 * the same defect pointed the other way.
	 */
	it("hands the operator the whole command, arguments included", () => {
		const warning = expiryWarnings([entry({ name: "DEPLOY_KEY" })], CREATED + DAY * 0.95)[0] ?? "";

		expect(warning).toContain("/secret extend DEPLOY_KEY --ttl 7d");
	});

	/**
	 * Reached when name generation has nowhere left to go: every generated name is taken, so the
	 * operator has to free one, and the advice has to say with what.
	 */
	it("names a runnable command when it tells you to free up a name", () => {
		const taken = new Set<string>();
		for (let n = 1; n < 10_000; n++) taken.add(`SECRET_${n}`);

		let thrown = "";
		try {
			generateSecretName(taken);
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}

		expect(thrown).toContain("/secret rm");
		expect(unrunnableWords(thrown)).toEqual([]);
	});

	/**
	 * THE CLASS, not the three strings above: every verb the parser reserves is safe to advertise on
	 * both surfaces. Derived from the parser's own table, so adding a verb that only one surface
	 * accepts turns this red without anyone remembering to extend a list.
	 */
	it("makes every verb the parser reserves safe to name in advice", () => {
		expect(SECRET_TUI_SUBCOMMANDS.length).toBeGreaterThan(5);

		for (const { name } of SECRET_TUI_SUBCOMMANDS) {
			expect(unrunnableWords(`Run /secret ${name} to fix it.`)).toEqual([]);
		}
	});

	/**
	 * The rule itself, proved against text rather than trusted. Without this, a helper that never
	 * matched anything would pass every case above by returning an empty array forever. `manager`
	 * is in the list on purpose: it is not a verb, so advice naming it is advice a terminal stores.
	 */
	it("catches a word no surface runs and clears one every surface does", () => {
		expect(unrunnableWords("Open /secret manager and move the file aside.")).toEqual([
			"manager (tui)",
			"manager (noninteractive)",
		]);
		expect(unrunnableWords("Fix it with /secret revoke NAME.")).toEqual(["revoke (tui)", "revoke (noninteractive)"]);
		expect(unrunnableWords("Run /secret discard --scope profile to repair it.")).toEqual([]);
		expect(unrunnableWords("Store it again with /secret add NAME --from-env VAR.")).toEqual([]);
		expect(unrunnableWords("Nothing actionable here.")).toEqual([]);
	});
});
