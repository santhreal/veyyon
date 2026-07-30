import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { buildTuiBuiltinSlashCommands } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * `/secret rm` and `/secret extend` both take the name of a stored credential, and until this
 * feature landed the operator had to recall that name from memory with nothing on screen to
 * recognise it by. That is a worse position than any other command's arguments put them in: the
 * entire point of a stored secret is that its value is never displayed, so `/secret list` was the
 * only way to recover a name, and a mistyped one is a silent no-op rather than something the
 * surface can correct.
 *
 * The completion is built from the RUNNING obfuscator, so these cases pin three things that are
 * each easy to get wrong and impossible to notice by eye:
 *
 *  1. The completion `value` must carry the VERB as well as the name. The TUI reports the whole
 *     argument text as the replaced span (`autocomplete.ts` sets `prefix: argumentText`, and
 *     `applyCompletion` splices `item.value` over exactly that span), so a value of just
 *     `GITHUB_TOKEN` would rewrite `/secret rm gi` into `/secret GITHUB_TOKEN` and silently drop
 *     the verb. No other builder in the registry returns a multi-token value, so there was no
 *     existing example to copy and nothing that would have caught this.
 *  2. A secret VALUE must never reach the dropdown. Names are already public in `/secret list`;
 *     values are the one thing the whole subsystem exists to keep off screen.
 *  3. Completion must stay silent rather than throw when there is no obfuscator, which is a real
 *     reachable state (secret protection turned off) in which `/secret rm` still has to work.
 */

const KEY = new Uint8Array(32).fill(23);

/** Long enough to be obfuscatable. Asserted ABSENT from every completion, never present. */
const VALUES = {
	github: "github-secret-value-0000",
	stripe: "stripe-secret-value-0000",
	gitlab: "gitlab-secret-value-0000",
} as const;

function runtimeWith(obfuscator: SecretObfuscator | undefined): TuiSlashCommandRuntime {
	return { ctx: { session: { obfuscator } } } as unknown as TuiSlashCommandRuntime;
}

/** Deliberately loaded out of alphabetical order so an unsorted implementation is visible. */
function threeStoredSecrets(): SecretObfuscator {
	return new SecretObfuscator(
		[
			{ type: "plain", origin: "config", content: VALUES.stripe, name: "STRIPE_KEY" },
			{ type: "plain", origin: "config", content: VALUES.github, name: "GITHUB_TOKEN" },
			{ type: "plain", origin: "config", content: VALUES.gitlab, name: "GITLAB_TOKEN" },
		],
		{ placeholderKey: KEY },
	);
}

function completionsFor(argumentText: string, obfuscator: SecretObfuscator | undefined) {
	const secret = buildTuiBuiltinSlashCommands(runtimeWith(obfuscator)).find(c => c.name === "secret");
	expect(secret).toBeDefined();
	expect(secret?.getArgumentCompletions).toBeDefined();
	return secret!.getArgumentCompletions!(argumentText);
}

describe("completing the name of a stored secret", () => {
	/**
	 * The headline case. Typing the verb and a space must offer every stored name, which is what
	 * removes the "run /secret list first, then retype it" round trip.
	 */
	it("offers every stored credential name after the rm verb", async () => {
		const result = await completionsFor("rm ", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["GITHUB_TOKEN", "GITLAB_TOKEN", "STRIPE_KEY"]);
	});

	/**
	 * Order is asserted explicitly rather than as a set, because the names are handed to the
	 * obfuscator reverse-alphabetically above. A dropdown that reshuffles between keystrokes moves
	 * the selected row under the operator, and `rm` is destructive, so the wrong row is not a
	 * cosmetic problem.
	 */
	it("lists the names sorted rather than in the order they were stored", async () => {
		const result = await completionsFor("extend ", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["GITHUB_TOKEN", "GITLAB_TOKEN", "STRIPE_KEY"]);
	});

	/**
	 * Prevents the regression described at (1) in the suite doc: a value of just the name would
	 * splice over the verb and produce `/secret GITHUB_TOKEN`, a command that does not exist.
	 */
	it("puts the verb in the completion value, because the whole argument span is replaced", async () => {
		const result = await completionsFor("rm GITHUB", threeStoredSecrets());
		expect(result?.map(item => item.value)).toEqual(["rm GITHUB_TOKEN"]);
	});

	/**
	 * `extend` needs `--ttl` after the name and `rm` is complete without anything further, so the
	 * trailing space is the difference between landing ready to keep typing and having to press
	 * space yourself. Derived from the declared usage string, not from naming `extend` twice.
	 */
	it("leaves the cursor ready for --ttl after extend but finishes the command after rm", async () => {
		const stored = threeStoredSecrets();
		expect((await completionsFor("extend STRIPE", stored))?.[0]?.value).toBe("extend STRIPE_KEY ");
		expect((await completionsFor("rm STRIPE", stored))?.[0]?.value).toBe("rm STRIPE_KEY");
	});

	/** Prefix filtering is what makes the dropdown usable once more than a couple are stored. */
	it("filters the names by what has been typed so far", async () => {
		const result = await completionsFor("rm GITL", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["GITLAB_TOKEN"]);
	});

	/**
	 * Secret names are upper-case by convention but nobody wants to hold shift to find one, and
	 * the command itself normalises the name it is given, so completion that did not match
	 * case-insensitively would be stricter than the command it feeds.
	 */
	it("matches case-insensitively, since the command normalises the name anyway", async () => {
		const result = await completionsFor("rm git", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["GITHUB_TOKEN", "GITLAB_TOKEN"]);
	});

	/** A prefix nothing matches must close the dropdown, not show every name as if unfiltered. */
	it("offers nothing when the typed prefix matches no stored name", async () => {
		expect(await completionsFor("rm NOPE", threeStoredSecrets())).toBeNull();
	});
});

describe("what secret completion refuses to offer", () => {
	/**
	 * The one that matters most. Names are already visible in `/secret list`; a value appearing in
	 * a dropdown would defeat the entire subsystem, so every field of every item is checked rather
	 * than just the label.
	 */
	it("never puts a credential value in any field of any completion", async () => {
		const result = await completionsFor("rm ", threeStoredSecrets());
		const serialised = JSON.stringify(result);
		for (const value of Object.values(VALUES)) {
			expect(serialised).not.toContain(value);
		}
	});

	/**
	 * `add` names a credential the operator is inventing. Offering the existing names there would
	 * read as a list of things to overwrite, which is the opposite of what the verb does.
	 */
	it("does not suggest existing names for add, which invents a new one", async () => {
		expect(await completionsFor("add ", threeStoredSecrets())).toBeNull();
	});

	/** `log` and `list` take no name, so a name dropdown there would be noise over a wrong slot. */
	it("does not suggest names for verbs that take none", async () => {
		const stored = threeStoredSecrets();
		expect(await completionsFor("log ", stored)).toBeNull();
		expect(await completionsFor("list ", stored)).toBeNull();
	});

	/**
	 * Once the name is typed the operator is into flags, and continuing to offer names would
	 * replace the whole argument span with a bare `extend NAME`, deleting the flag being typed.
	 *
	 * The mechanism is the prefix filter, not a dedicated guard: a valid secret name cannot
	 * contain a space, so flag text matches nothing. An explicit guard was written first and
	 * removed after a negative control showed its presence and absence were indistinguishable.
	 * Stated here because the obvious reading of this test is that some branch checks for flags.
	 */
	it("stops offering names once the argument has moved on to flags", async () => {
		expect(await completionsFor("extend STRIPE_KEY --ttl ", threeStoredSecrets())).toBeNull();
	});

	/** An unrecognised verb must not be treated as a name-taking one. */
	it("offers nothing after a verb it does not know", async () => {
		expect(await completionsFor("bogus ", threeStoredSecrets())).toBeNull();
	});
});

describe("secret completion when there is nothing to complete", () => {
	/**
	 * Secret protection being off is a reachable state in which the vault still holds entries and
	 * `/secret rm` still works. Completion is a convenience and goes quiet, but it must not throw:
	 * an exception here would surface as a broken dropdown on every keystroke of an unrelated
	 * command, because the completion is invoked from the shared autocomplete path.
	 */
	it("stays silent instead of throwing when secret protection is off", async () => {
		expect(await completionsFor("rm ", undefined)).toBeNull();
	});

	/** An empty vault has no names, and an empty dropdown is worse than none. */
	it("offers nothing when no credential is stored", async () => {
		expect(await completionsFor("rm ", new SecretObfuscator([], { placeholderKey: KEY }))).toBeNull();
	});
});

describe("the verb list this feature had to keep working", () => {
	/**
	 * The name completion is layered in front of the existing subcommand completion, so the verb
	 * dropdown is the thing most likely to be broken by accident. It is the only completion
	 * `/secret` had before this change.
	 */
	it("still completes the verbs themselves before one has been chosen", async () => {
		const result = await completionsFor("", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["add", "list", "rm", "extend", "log"]);
	});

	/** Verb filtering is likewise pre-existing behavior that the new branch must not swallow. */
	it("still filters the verb list by prefix", async () => {
		const result = await completionsFor("ex", threeStoredSecrets());
		expect(result?.map(item => item.label)).toEqual(["extend"]);
	});

	/**
	 * The verb list must not depend on the obfuscator existing, since choosing `rm` is exactly what
	 * an operator does when protection is off.
	 */
	it("still completes verbs with no obfuscator at all", async () => {
		expect((await completionsFor("rm", undefined))?.map(item => item.label)).toEqual(["rm"]);
	});
});
