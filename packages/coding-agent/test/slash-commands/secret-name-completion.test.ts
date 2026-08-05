import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { buildTuiBuiltinSlashCommands } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * What `/secret` may offer in its argument dropdown, now that the terminal grammar has no verbs.
 *
 * THIS SUITE REPLACED THE OPPOSITE CONTRACT, and the reversal is the point. The dropdown used to
 * complete `rm` and `extend` and then the names of stored credentials, so `/secret rm git` offered
 * `GITHUB_TOKEN`. Under the terminal grammar the argument line IS the credential, so accepting
 * that suggestion would no longer revoke anything: it would STORE the text `rm GITHUB_TOKEN` as a
 * secret, under a generated name, and report success. A dropdown that quietly converts a revoke
 * into a bogus credential is worse than no dropdown at all.
 *
 * So the completion now offers exactly one item, `manager`, and the cases below pin three things
 * that are each easy to reintroduce and impossible to notice by eye:
 *
 *  1. No verb is ever offered. Every former verb is ordinary credential text now, and offering one
 *     is the trap described above.
 *  2. No stored NAME and no stored VALUE reaches the dropdown. Values are what the whole subsystem
 *     exists to keep off screen; names are no longer offered here because there is no longer a
 *     position in the command where a name belongs.
 *  3. The prefix filter closes the dropdown on a real credential. An operator pasting a token must
 *     not have a suggestion list open over it.
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

/**
 * The declared return type allows a promise (other commands complete from disk), so this awaits
 * it. `/secret`'s own builder is synchronous, and that is the point: a dropdown on a line holding
 * a credential must not wait on I/O.
 */
async function completionsFor(argumentText: string, obfuscator: SecretObfuscator | undefined) {
	const secret = buildTuiBuiltinSlashCommands(runtimeWith(obfuscator)).find(c => c.name === "secret");
	expect(secret).toBeDefined();
	expect(secret?.getArgumentCompletions).toBeDefined();
	return await secret!.getArgumentCompletions!(argumentText);
}

describe("what /secret offers in its argument dropdown", () => {
	/**
	 * The one thing there is to offer. Typing nothing after `/secret ` surfaces the manager, which
	 * is how an operator discovers that the GUI exists at all: it is the only word the grammar
	 * reserves, and nothing else on screen names it.
	 */
	it("offers the manager and nothing else on an empty argument", async () => {
		const items = await completionsFor("", threeStoredSecrets());

		expect(items).toEqual([
			{
				value: "manager",
				label: "manager",
				description: "list, rename, extend, revoke and copy what you have stored",
			},
		]);
	});

	/**
	 * LOCKS OUT THE TRAP DIRECTLY. `rm` is no longer a verb, so completing it would produce a
	 * suggestion whose acceptance stores `rm <name>` as a credential. This is the single assertion
	 * that fails if the old name-completion builder is ever restored.
	 */
	it("offers nothing for a former verb", async () => {
		for (const verb of ["rm", "extend", "add", "list", "log", "discard"]) {
			expect(await completionsFor(verb, threeStoredSecrets())).toBeNull();
		}
	});

	/**
	 * The old builder's exact input. `rm git` once returned `rm GITHUB_TOKEN` and `rm GITLAB_TOKEN`;
	 * accepting either now stores that text. Pinned as its own case because it is the literal
	 * keystroke sequence from the feature that was removed.
	 */
	it("offers nothing for a verb followed by a partial secret name", async () => {
		expect(await completionsFor("rm git", threeStoredSecrets())).toBeNull();
	});

	/**
	 * Neither a stored NAME nor a stored VALUE may appear in the dropdown. The value case is the
	 * one the whole subsystem exists for; the name case is what stops the dropdown from becoming a
	 * second `/secret list` that renders on every keystroke of a credential.
	 */
	it("never renders a stored name or value", async () => {
		for (const prefix of ["", "m", "man", "GITHUB", "git", "rm "]) {
			const rendered = JSON.stringify((await completionsFor(prefix, threeStoredSecrets())) ?? []);
			for (const value of Object.values(VALUES)) expect(rendered).not.toContain(value);
			for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "STRIPE_KEY"]) expect(rendered).not.toContain(name);
		}
	});

	/**
	 * A pasted credential closes the dropdown rather than hanging a suggestion over it. The filter
	 * is what makes a single always-available completion tolerable on a line whose contents are
	 * secret: a real token shares no prefix with `manager`.
	 */
	it("closes on text that is not a prefix of the reserved word", async () => {
		expect(await completionsFor("ghp_liveCredential000", threeStoredSecrets())).toBeNull();
		expect(await completionsFor("x", threeStoredSecrets())).toBeNull();
	});

	/**
	 * Partial and differently-cased spellings still reach the manager. The parser lowercases the
	 * reserved word, so a dropdown that matched case-sensitively would refuse to complete an input
	 * the command itself accepts.
	 */
	it("matches a partial or upper-case spelling of the reserved word", async () => {
		expect((await completionsFor("man", undefined))?.map(item => item.value)).toEqual(["manager"]);
		expect((await completionsFor("MAN", undefined))?.map(item => item.value)).toEqual(["manager"]);
		expect((await completionsFor("manager", undefined))?.map(item => item.value)).toEqual(["manager"]);
	});

	/**
	 * Completion must not depend on the obfuscator, which is absent whenever secret protection is
	 * off. The old builder read stored names from it and went silent in that state; the manager is
	 * exactly what an operator in that state needs to reach, so it must still be offered.
	 */
	it("offers the manager when there is no obfuscator at all", async () => {
		expect((await completionsFor("", undefined))?.map(item => item.value)).toEqual(["manager"]);
	});
});
